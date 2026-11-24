#include <setjmp.h>
#include <string.h>
#include <sys/stat.h>
#include "acl_decode.h"

static jmp_buf failure_jump;
static const char *failure;
static void fail_jump(const char *what, const char *path, int error) {
  (void)path; (void)error; failure = what; longjmp(failure_jump, 1);
}
static void require(int condition) { if (!condition) { perror("native ACL fixture"); exit(1); } }

/* The public setter refuses generic masks. Import the real native-buffer layout instead. */
static acl_t imported(acl_permset_mask_t mask, int empty) {
  acl_t acl = acl_init(empty ? 0 : 1);
  require(acl != NULL);
  if (!empty) {
    acl_entry_t entry;
    uuid_t everyone;
    require(acl_create_entry(&acl, &entry) == 0);
    require(acl_set_tag_type(entry, ACL_EXTENDED_ALLOW) == 0);
    require(mbr_gid_to_uuid(12, everyone) == 0 && acl_set_qualifier(entry, everyone) == 0);
    require(acl_set_permset_mask_np(entry, ACL_READ_DATA) == 0);
  }
  size_t length; unsigned count;
  void *buffer = holdr_acl_bytes(acl, &length, &count, "fixture", fail_jump);
  struct kauth_filesec *native = buffer;
  if (!empty) native->fsec_acl.acl_ace[0].ace_rights = (kauth_ace_rights_t)mask;
  acl_t result = acl_copy_int_native(buffer);
  require(result != NULL);
  free(buffer); acl_free(acl);
  return result;
}

int main(int argc, char **argv) {
  if (argc != 2) return 64;
  const struct { const char *name; acl_permset_mask_t mask; int empty; } cases[] = {
    { "a", KAUTH_ACE_GENERIC_ALL, 0 }, { "w", KAUTH_ACE_GENERIC_WRITE, 0 },
    { "x", KAUTH_ACE_GENERIC_EXECUTE, 0 }, { "r", KAUTH_ACE_GENERIC_READ, 0 },
    { "u", (acl_permset_mask_t)1 << 30, 0 }, { "e", 0, 1 },
  };
  for (size_t i = 0; i < sizeof cases / sizeof cases[0]; i++) {
    acl_t acl = imported(cases[i].mask, cases[i].empty);
    int valid = acl_valid(acl);
    size_t length; unsigned count;
    void *bytes = holdr_acl_bytes(acl, &length, &count, "fixture", fail_jump);
    free(bytes);
    unsigned old_visible = 0;
    if (count) {
      acl_entry_t entry; acl_permset_t perms;
      require(acl_get_entry(acl, ACL_FIRST_ENTRY, &entry) == 0 && acl_get_permset(entry, &perms) == 0);
      for (size_t k = 0; k < sizeof HOLDR_RIGHTS / sizeof HOLDR_RIGHTS[0]; k++)
        if (acl_get_perm_np(perms, (acl_perm_t)HOLDR_RIGHTS[k].bit) == 1) old_visible++;
    }
    char target[4096];
    require(snprintf(target, sizeof target, "%s/%s", argv[1], cases[i].name) < (int)sizeof target);
    require(mkdir(target, 0755) == 0);
    int applied = acl_set_file(target, ACL_TYPE_EXTENDED, acl);
    printf("{\"case\":\"%s\",\"valid\":%d,\"oldVisible\":%u,\"applied\":%d", cases[i].name, valid, old_visible, applied);
    char *line = NULL; size_t size = 0;
    FILE *out = open_memstream(&line, &size);
    require(out != NULL);
    if (setjmp(failure_jump) == 0) {
      holdr_print_acl(out, acl, count, target, fail_jump);
      fclose(out);
      printf(",\"ok\":true%s", line);
    } else {
      fclose(out);
      printf(",\"ok\":false,\"failure\":\"%s\"", failure);
    }
    printf("}\n");
    free(line); acl_free(acl);
  }
  return 0;
}
