#include <sys/types.h>
#include <sys/acl.h>
#include <sys/stat.h>
#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#define INTERPOSE(replacement, original) \
  __attribute__((used)) static struct { const void *new_fn; const void *old_fn; } hook_##original \
  __attribute__((section("__DATA,__interpose"))) = { (const void *)(unsigned long)&replacement, (const void *)(unsigned long)&original };

static int calls, properties;
static int selected(const char *mode) { const char *value = getenv("HOLDR_RACE_MODE"); return value && strcmp(mode, value) == 0; }
static int target(int fd) {
  struct stat stat;
  const char *ino = getenv("HOLDR_RACE_INO");
  return ino && fstat(fd, &stat) == 0 && (unsigned long long)stat.st_ino == strtoull(ino, NULL, 10);
}
static void mutate(int fd, int restore) {
  filesec_t security = filesec_init();
  mode_t mode = restore ? 0755 : 0777;
  acl_t acl = restore ? acl_from_text("!#acl 1\ngroup:ABCDEFAB-CDEF-ABCD-EFAB-CDEF0000000C:everyone:12:allow:writesecurity\n") : NULL;
  if (!security || (restore && !acl) || filesec_set_property(security, FILESEC_MODE, &mode) != 0 ||
    filesec_set_property(security, FILESEC_ACL, restore ? (void *)&acl : _FILESEC_REMOVE_ACL) != 0 ||
    fchmodx_np(fd, security) != 0) _Exit(90);
  if (acl) acl_free(acl);
  filesec_free(security);
}
static int race_stat(int fd, struct stat *stat, filesec_t security) {
  if (!target(fd)) return fstatx_np(fd, stat, security);
  calls++;
  if (selected("eio")) { errno = EIO; return -1; }
  if (selected("before") && calls == 1) mutate(fd, 0);
  if (selected("flap")) mutate(fd, !(calls & 1));
  if (selected("torn") && calls == 1) {
    struct stat old;
    if (fstat(fd, &old) != 0) _Exit(91);
    mutate(fd, 0);
    int result = fstatx_np(fd, stat, security);
    *stat = old;
    return result;
  }
  int result = fstatx_np(fd, stat, security);
  if (selected("after") && calls == 1) mutate(fd, 0);
  if (selected("ctime-only") && calls == 1) {
    if (fchmod(fd, 0777) != 0 || fchmod(fd, 0755) != 0) _Exit(92);
  }
  return result;
}
static int race_property(filesec_t security, filesec_property_t property, void *value) {
  properties++;
  if (selected("prop-eio") && properties == 3) { errno = EIO; return -1; }
  if (selected("empty-acl") && property == FILESEC_ACL) {
    *(acl_t *)value = acl_init(0);
    return *(acl_t *)value ? 0 : -1;
  }
  return filesec_get_property(security, property, value);
}
__attribute__((destructor)) static void report_calls(void) { fprintf(stderr, "target-snapshots=%d\n", calls); }
INTERPOSE(race_stat, fstatx_np)
INTERPOSE(race_property, filesec_get_property)
