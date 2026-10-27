#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <linux/audit.h>
#include <linux/filter.h>
#include <linux/landlock.h>
#include <linux/seccomp.h>
#include <stddef.h>
#include <stdlib.h>
#include <sys/prctl.h>
#include <sys/resource.h>
#include <sys/stat.h>
#include <sys/syscall.h>
#include <unistd.h>

#if defined(__x86_64__)
#define SANDBOX_ARCH AUDIT_ARCH_X86_64
#elif defined(__aarch64__)
#define SANDBOX_ARCH AUDIT_ARCH_AARCH64
#else
#error Unsupported sandbox architecture
#endif
#define DENY(n) BPF_JUMP(BPF_JMP|BPF_JEQ|BPF_K, __NR_##n, 0, 1), BPF_STMT(BPF_RET|BPF_K, SECCOMP_RET_ERRNO|EPERM)

static int allow_path(int ruleset, const char *name, unsigned long long access) {
  int path = open(name, O_PATH|O_CLOEXEC);
  if (path < 0) return -1;
  struct stat stat;
  if (fstat(path, &stat)) { close(path); return -1; }
  if (!S_ISDIR(stat.st_mode)) access &= LANDLOCK_ACCESS_FS_READ_FILE|LANDLOCK_ACCESS_FS_WRITE_FILE|LANDLOCK_ACCESS_FS_EXECUTE|LANDLOCK_ACCESS_FS_TRUNCATE;
  struct landlock_path_beneath_attr rule = {.allowed_access=access,.parent_fd=path};
  int result = syscall(SYS_landlock_add_rule, ruleset, LANDLOCK_RULE_PATH_BENEATH, &rule, 0);
  close(path);
  return result;
}
int main(int argc, char **argv) {
  if (argc < 6 || prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0)) return 120;
  char *end;
  long count = strtol(argv[2], &end, 10);
  if (*end || count < 1 || count > 64 || argc < count + 5) return 120;
  unsigned long long read_access = LANDLOCK_ACCESS_FS_READ_FILE|LANDLOCK_ACCESS_FS_READ_DIR|LANDLOCK_ACCESS_FS_EXECUTE;
  struct landlock_ruleset_attr rules = {.handled_access_fs=read_access|LANDLOCK_ACCESS_FS_WRITE_FILE|LANDLOCK_ACCESS_FS_REMOVE_DIR|LANDLOCK_ACCESS_FS_REMOVE_FILE|LANDLOCK_ACCESS_FS_MAKE_CHAR|LANDLOCK_ACCESS_FS_MAKE_DIR|LANDLOCK_ACCESS_FS_MAKE_REG|LANDLOCK_ACCESS_FS_MAKE_SOCK|LANDLOCK_ACCESS_FS_MAKE_FIFO|LANDLOCK_ACCESS_FS_MAKE_BLOCK|LANDLOCK_ACCESS_FS_MAKE_SYM|LANDLOCK_ACCESS_FS_REFER|LANDLOCK_ACCESS_FS_TRUNCATE};
  int fd = syscall(SYS_landlock_create_ruleset, &rules, sizeof(rules), 0);
  if (fd < 0) return 121;
  if (allow_path(fd, argv[1], rules.handled_access_fs & ~LANDLOCK_ACCESS_FS_EXECUTE)) return 122;
  for (long i=0; i<count; i++) if (allow_path(fd, argv[3+i], read_access)) return 122;
  if (syscall(SYS_landlock_restrict_self, fd, 0)) return 122;
  close(fd);
  struct sock_filter filter[] = {
    BPF_STMT(BPF_LD|BPF_W|BPF_ABS, offsetof(struct seccomp_data, arch)),
    BPF_JUMP(BPF_JMP|BPF_JEQ|BPF_K, SANDBOX_ARCH, 1, 0),
    BPF_STMT(BPF_RET|BPF_K, SECCOMP_RET_KILL_PROCESS),
    BPF_STMT(BPF_LD|BPF_W|BPF_ABS, offsetof(struct seccomp_data, nr)),
#if defined(__x86_64__)
    BPF_JUMP(BPF_JMP|BPF_JGE|BPF_K, 0x40000000, 0, 1),
    BPF_STMT(BPF_RET|BPF_K, SECCOMP_RET_KILL_PROCESS),
#endif
    BPF_JUMP(BPF_JMP|BPF_JEQ|BPF_K, __NR_fcntl, 0, 7),
    BPF_STMT(BPF_LD|BPF_W|BPF_ABS, offsetof(struct seccomp_data, args[1])),
    BPF_JUMP(BPF_JMP|BPF_JEQ|BPF_K, F_SETOWN, 0, 1), BPF_STMT(BPF_RET|BPF_K, SECCOMP_RET_ERRNO|EPERM),
    BPF_JUMP(BPF_JMP|BPF_JEQ|BPF_K, F_SETOWN_EX, 0, 1), BPF_STMT(BPF_RET|BPF_K, SECCOMP_RET_ERRNO|EPERM),
    BPF_JUMP(BPF_JMP|BPF_JEQ|BPF_K, F_SETSIG, 0, 1), BPF_STMT(BPF_RET|BPF_K, SECCOMP_RET_ERRNO|EPERM),
    BPF_STMT(BPF_LD|BPF_W|BPF_ABS, offsetof(struct seccomp_data, nr)),
    BPF_JUMP(BPF_JMP|BPF_JEQ|BPF_K, __NR_prlimit64, 0, 3),
    BPF_STMT(BPF_LD|BPF_W|BPF_ABS, offsetof(struct seccomp_data, args[0])),
    BPF_JUMP(BPF_JMP|BPF_JEQ|BPF_K, 0, 1, 0),
    BPF_STMT(BPF_RET|BPF_K, SECCOMP_RET_ERRNO|EPERM),
    BPF_STMT(BPF_LD|BPF_W|BPF_ABS, offsetof(struct seccomp_data, nr)),
    DENY(socket), DENY(connect), DENY(bind), DENY(listen), DENY(accept), DENY(accept4), DENY(sendto), DENY(sendmsg), DENY(sendmmsg),
    DENY(ptrace), DENY(process_vm_readv), DENY(process_vm_writev), DENY(pidfd_getfd), DENY(io_uring_setup), DENY(bpf), DENY(perf_event_open),
    DENY(kill), DENY(tkill), DENY(tgkill), DENY(pidfd_send_signal), DENY(rt_sigqueueinfo), DENY(rt_tgsigqueueinfo),
    DENY(setpriority), DENY(sched_setparam), DENY(sched_setscheduler), DENY(sched_setaffinity), DENY(sched_setattr), DENY(ioprio_set),
    DENY(shmget), DENY(shmat), DENY(shmdt), DENY(shmctl), DENY(semget), DENY(semop), DENY(semctl), DENY(semtimedop), DENY(msgget), DENY(msgsnd), DENY(msgrcv), DENY(msgctl),
    DENY(add_key), DENY(request_key),
    DENY(chmod), DENY(fchmod), DENY(fchmodat), DENY(fchown), DENY(fchownat),
#if defined(__NR_fchmodat2)
    DENY(fchmodat2),
#endif
#if defined(__NR_chown)
    DENY(chown), DENY(lchown),
#endif
#if defined(__NR_utime)
    DENY(utime), DENY(utimes), DENY(futimesat),
#endif
    DENY(utimensat), DENY(setxattr), DENY(lsetxattr), DENY(fsetxattr), DENY(removexattr), DENY(lremovexattr), DENY(fremovexattr),
#if defined(__NR_setxattrat)
    DENY(setxattrat),
#endif
#if defined(__NR_getxattrat)
    DENY(getxattrat),
#endif
#if defined(__NR_listxattrat)
    DENY(listxattrat),
#endif
#if defined(__NR_removexattrat)
    DENY(removexattrat),
#endif
    DENY(setsid), DENY(setpgid), DENY(mount), DENY(umount2), DENY(pivot_root), DENY(setns), DENY(unshare), DENY(open_by_handle_at), DENY(keyctl), DENY(reboot), DENY(kexec_load), DENY(init_module), DENY(finit_module), DENY(delete_module),
    BPF_STMT(BPF_RET|BPF_K, SECCOMP_RET_ALLOW)
  };
  struct sock_fprog program = {.len=sizeof(filter)/sizeof(filter[0]), .filter=filter};
  if (prctl(PR_SET_SECCOMP, SECCOMP_MODE_FILTER, &program)) return 123;
  struct rlimit file_limit = {32*1024*1024,32*1024*1024};
  struct rlimit core_limit = {0,0};
  if (setrlimit(RLIMIT_FSIZE,&file_limit) || setrlimit(RLIMIT_CORE,&core_limit)) return 124;
  execv(argv[count+3], argv+count+3);
  return 125;
}
