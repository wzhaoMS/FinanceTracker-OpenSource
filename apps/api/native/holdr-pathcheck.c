#include <sys/types.h>
#include <sys/stat.h>
#include <sys/acl.h>
#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include "acl_decode.h"

#define SNAPSHOT_TRIES 5
#define SOCKET_PATH_MAX 100

static void jstr(FILE *out, const char *value) {
  fputc('"', out);
  for (const unsigned char *p = (const unsigned char *)value; *p; p++) {
    if (*p == '"' || *p == '\\') { fputc('\\', out); fputc(*p, out); }
    else if (*p < 0x20) fprintf(out, "\\u%04x", *p);
    else fputc(*p, out);
  }
  fputc('"', out);
}

static const char *errname(int error) {
  switch (error) {
    case EACCES: return "EACCES"; case EPERM: return "EPERM"; case ELOOP: return "ELOOP";
    case ENOTDIR: return "ENOTDIR"; case ENOENT: return "ENOENT"; case EIO: return "EIO";
    case ENOMEM: return "ENOMEM"; case EINVAL: return "EINVAL"; case EAGAIN: return "EAGAIN";
    default: return "EOTHER";
  }
}

static void fail(const char *what, const char *path, int error) {
  printf("{\"error\":"); jstr(stdout, what); printf(",\"path\":"); jstr(stdout, path);
  printf(",\"errno\":\"%s\",\"code\":%d}\n", errname(error), error);
  fflush(stdout);
  exit(2);
}

struct snapshot {
  struct stat stat;
  acl_t acl;
  void *bytes;
  size_t length;
  unsigned count;
};

static void release_snapshot(struct snapshot *snapshot) {
  if (snapshot->acl) acl_free(snapshot->acl);
  free(snapshot->bytes);
}

/* Stat and ACL come from the SAME filesec acquisition, never from separate reads. */
static int read_snapshot(int fd, const char *path, struct snapshot *snapshot) {
  memset(snapshot, 0, sizeof *snapshot);
  filesec_t security = filesec_init();
  if (!security) fail("filesec_init", path, errno);
  int result = fd >= 0 ? fstatx_np(fd, &snapshot->stat, security) : lstatx_np(path, &snapshot->stat, security);
  if (result != 0) {
    int error = errno;
    filesec_free(security);
    if (fd < 0 && error == ENOENT) return ENOENT;
    fail(fd >= 0 ? "fstatx_np" : "lstatx_np", path, error);
  }
  errno = 0;
  if (filesec_get_property(security, FILESEC_ACL, &snapshot->acl) != 0) {
    int error = errno;
    filesec_free(security);
    if (error != ENOENT) fail("filesec_get_property", path, error);
    snapshot->acl = NULL;
  } else {
    filesec_free(security);
    if (!snapshot->acl) fail("acl-unknown-layout", path, EINVAL);
    snapshot->bytes = holdr_acl_bytes(snapshot->acl, &snapshot->length, &snapshot->count, path, fail);
  }
  return 0;
}

static int same_snapshot(const struct snapshot *a, const struct snapshot *b) {
  const struct stat *x = &a->stat, *y = &b->stat;
  return x->st_dev == y->st_dev && x->st_ino == y->st_ino && x->st_mode == y->st_mode &&
    x->st_uid == y->st_uid && x->st_gid == y->st_gid && x->st_flags == y->st_flags &&
    x->st_ctimespec.tv_sec == y->st_ctimespec.tv_sec && x->st_ctimespec.tv_nsec == y->st_ctimespec.tv_nsec &&
    (a->acl == NULL) == (b->acl == NULL) && a->length == b->length &&
    (a->length == 0 || memcmp(a->bytes, b->bytes, a->length) == 0);
}

/* XNU's EA fallback can tear even one syscall; two agreeing snapshots fence it. */
static int fenced_snapshot(int fd, const char *path, struct snapshot *out) {
  for (int attempt = 0; attempt < SNAPSHOT_TRIES; attempt++) {
    struct snapshot a, b;
    int first = read_snapshot(fd, path, &a);
    int second = read_snapshot(fd, path, &b);
    if (first == ENOENT && second == ENOENT) return ENOENT;
    if (first == 0 && second == 0 && same_snapshot(&a, &b)) {
      *out = a;
      release_snapshot(&b);
      return 0;
    }
    release_snapshot(&a);
    release_snapshot(&b);
  }
  fail("metadata-unstable", path, EAGAIN);
  return EAGAIN;
}

static void report(const char *kind, const char *path, const struct snapshot *snapshot) {
  char *line = NULL;
  size_t length = 0;
  FILE *out = open_memstream(&line, &length);
  if (!out) fail("open_memstream", path, errno);
  const struct stat *st = &snapshot->stat;
  const char *type = S_ISDIR(st->st_mode) ? "dir" : S_ISSOCK(st->st_mode) ? "socket" : S_ISLNK(st->st_mode) ? "symlink" : "other";
  fprintf(out, "{\"kind\":\"%s\",\"path\":", kind); jstr(out, path);
  /* Decimal strings retain all 64 identity bits in the Node parser. */
  fprintf(out, ",\"type\":\"%s\",\"uid\":%u,\"gid\":%u,\"mode\":%u,\"dev\":\"%lld\",\"ino\":\"%llu\",\"aclPresent\":%s",
          type, (unsigned)st->st_uid, (unsigned)st->st_gid, (unsigned)(st->st_mode & 07777),
          (long long)st->st_dev, (unsigned long long)st->st_ino, snapshot->acl ? "true" : "false");
  holdr_print_acl(out, snapshot->acl, snapshot->count, path, fail);
  fprintf(out, "}\n");
  if (fclose(out) != 0) fail("fclose", path, errno);
  if (fwrite(line, 1, length, stdout) != length) fail("write", path, errno);
  free(line);
}

int main(int argc, char **argv) {
  if (argc != 2 || argv[1][0] != '/' || strlen(argv[1]) > SOCKET_PATH_MAX ||
      strlen(argv[1]) < 2 || argv[1][strlen(argv[1]) - 1] == '/' || strstr(argv[1], "//")) return 64;
  for (const unsigned char *p = (const unsigned char *)argv[1]; *p; p++) if (*p < 0x20 || *p == 0x7f) return 64;
  printf("{\"format\":\"holdr-pathcheck/5\"}\n");
  char path[SOCKET_PATH_MAX + 1];
  memcpy(path, argv[1], strlen(argv[1]) + 1);
  char *last = strrchr(path, '/');
  const char *socket_name = last + 1;
  if (strcmp(socket_name, ".") == 0 || strcmp(socket_name, "..") == 0) fail("dot-segment", argv[1], EINVAL);
  *last = '\0';
  char shown[SOCKET_PATH_MAX + 1] = "/";
  int fd = open("/", O_RDONLY | O_DIRECTORY | O_NOFOLLOW);
  if (fd < 0) fail("open", "/", errno);
  unsigned objects = 0;
  char *save = NULL;
  char *name = strtok_r(path, "/", &save);
  for (;;) {
    struct snapshot snapshot;
    fenced_snapshot(fd, shown, &snapshot);
    report("dir", shown, &snapshot);
    release_snapshot(&snapshot);
    objects++;
    if (!name) break;
    if (strcmp(name, ".") == 0 || strcmp(name, "..") == 0) fail("dot-segment", shown, EINVAL);
    if (strlen(shown) > 1 && strlcat(shown, "/", sizeof shown) >= sizeof shown) fail("path-too-long", shown, EINVAL);
    if (strlcat(shown, name, sizeof shown) >= sizeof shown) fail("path-too-long", shown, EINVAL);
    int next = openat(fd, name, O_RDONLY | O_DIRECTORY | O_NOFOLLOW);
    if (next < 0) fail("openat", shown, errno);
    if (close(fd) != 0) fail("close", shown, errno);
    fd = next;
    name = strtok_r(NULL, "/", &save);
  }
  struct snapshot socket;
  if (fenced_snapshot(-1, argv[1], &socket) == ENOENT) {
    printf("{\"kind\":\"absent\",\"path\":"); jstr(stdout, argv[1]); printf("}\n");
  } else {
    report("socket", argv[1], &socket);
    release_snapshot(&socket);
  }
  if (close(fd) != 0) fail("close", shown, errno);
  printf("{\"done\":true,\"objects\":%u}\n", objects + 1);
  if (fflush(stdout) != 0) return 2;
  return 0;
}
