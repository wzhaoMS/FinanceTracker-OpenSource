#ifndef HOLDR_ACL_DECODE_H
#define HOLDR_ACL_DECODE_H

#include <sys/types.h>
#include <sys/acl.h>
#include <sys/kauth.h>
#include <errno.h>
#include <membership.h>
#include <stddef.h>
#include <stdio.h>
#include <stdlib.h>

typedef void (*holdr_fail_fn)(const char *, const char *, int);

/* XNU expands these before vnode authorization (kern_authorization.c:655-670). */
_Static_assert(KAUTH_VNODE_GENERIC_ALL_BITS == 0x1ffe, "generic ALL changed");
_Static_assert(KAUTH_VNODE_GENERIC_EXECUTE_BITS == 0x8, "generic EXECUTE changed");
_Static_assert(KAUTH_VNODE_GENERIC_WRITE_BITS == 0x1574, "generic WRITE changed");
_Static_assert(KAUTH_VNODE_GENERIC_READ_BITS == 0xa82, "generic READ changed");

#define HOLDR_GENERIC_BITS (KAUTH_ACE_GENERIC_ALL | KAUTH_ACE_GENERIC_EXECUTE | KAUTH_ACE_GENERIC_WRITE | KAUTH_ACE_GENERIC_READ)
#define HOLDR_ACL_MAX_BYTES (1024 * 1024)

static const struct { acl_permset_mask_t bit; const char *name; } HOLDR_RIGHTS[] = {
  { ACL_READ_DATA, "list" }, { ACL_WRITE_DATA, "add_file" }, { ACL_EXECUTE, "search" }, { ACL_DELETE, "delete" },
  { ACL_APPEND_DATA, "add_subdirectory" }, { ACL_DELETE_CHILD, "delete_child" }, { ACL_READ_ATTRIBUTES, "readattr" },
  { ACL_WRITE_ATTRIBUTES, "writeattr" }, { ACL_READ_EXTATTRIBUTES, "readextattr" }, { ACL_WRITE_EXTATTRIBUTES, "writeextattr" },
  { ACL_READ_SECURITY, "readsecurity" }, { ACL_WRITE_SECURITY, "writesecurity" }, { ACL_CHANGE_OWNER, "chown" },
  { ACL_SYNCHRONIZE, "synchronize" },
};
static const struct { acl_permset_mask_t bit; const char *name; } HOLDR_GENERICS[] = {
  { KAUTH_ACE_GENERIC_ALL, "generic_all" }, { KAUTH_ACE_GENERIC_EXECUTE, "generic_execute" },
  { KAUTH_ACE_GENERIC_WRITE, "generic_write" }, { KAUTH_ACE_GENERIC_READ, "generic_read" },
};
static const struct { acl_flag_t flag; const char *name; } HOLDR_FLAGS[] = {
  { ACL_ENTRY_INHERITED, "inherited" }, { ACL_ENTRY_FILE_INHERIT, "file_inherit" },
  { ACL_ENTRY_DIRECTORY_INHERIT, "directory_inherit" }, { ACL_ENTRY_LIMIT_INHERIT, "limit_inherit" },
  { ACL_ENTRY_ONLY_INHERIT, "only_inherit" },
};

static acl_permset_mask_t holdr_known_rights(void) {
  acl_permset_mask_t mask = 0;
  for (size_t i = 0; i < sizeof HOLDR_RIGHTS / sizeof HOLDR_RIGHTS[0]; i++) mask |= HOLDR_RIGHTS[i].bit;
  return mask;
}

static acl_permset_mask_t holdr_expand(acl_permset_mask_t raw) {
  acl_permset_mask_t expanded = raw & ~(acl_permset_mask_t)HOLDR_GENERIC_BITS;
  if (raw & KAUTH_ACE_GENERIC_ALL) expanded |= KAUTH_VNODE_GENERIC_ALL_BITS;
  if (raw & KAUTH_ACE_GENERIC_EXECUTE) expanded |= KAUTH_VNODE_GENERIC_EXECUTE_BITS;
  if (raw & KAUTH_ACE_GENERIC_WRITE) expanded |= KAUTH_VNODE_GENERIC_WRITE_BITS;
  if (raw & KAUTH_ACE_GENERIC_READ) expanded |= KAUTH_VNODE_GENERIC_READ_BITS;
  return expanded;
}

static void *holdr_acl_bytes(acl_t acl, size_t *length, unsigned *count, const char *path, holdr_fail_fn fail) {
  ssize_t size = acl_size(acl);
  if (size < 0) fail("acl_size", path, errno);
  if (size < (ssize_t)offsetof(struct kauth_filesec, fsec_acl.acl_ace) || size > HOLDR_ACL_MAX_BYTES)
    fail("acl-unknown-layout", path, EINVAL);
  void *bytes = calloc(1, (size_t)size);
  if (!bytes) fail("calloc", path, ENOMEM);
  ssize_t copied = acl_copy_ext_native(bytes, acl, size);
  if (copied < 0) fail("acl_copy_ext_native", path, errno);
  struct kauth_filesec *fsec = bytes;
  size_t base = offsetof(struct kauth_filesec, fsec_acl.acl_ace);
  if (copied < (ssize_t)base || copied > size || fsec->fsec_magic != KAUTH_FILESEC_MAGIC ||
      fsec->fsec_acl.acl_entrycount > 128 ||
      base + fsec->fsec_acl.acl_entrycount * sizeof(struct kauth_ace) > (size_t)copied)
    fail("acl-unknown-layout", path, EINVAL);
  *length = (size_t)copied;
  *count = fsec->fsec_acl.acl_entrycount;
  return bytes;
}

static void holdr_print_acl(FILE *out, acl_t acl, unsigned count, const char *path, holdr_fail_fn fail) {
  fprintf(out, ",\"acl\":[");
  for (unsigned i = 0; i < count; i++) {
    acl_entry_t entry;
    if (acl_get_entry(acl, i == 0 ? ACL_FIRST_ENTRY : ACL_NEXT_ENTRY, &entry) != 0)
      fail("acl_get_entry", path, errno);
    acl_tag_t tag;
    if (acl_get_tag_type(entry, &tag) != 0) fail("acl_get_tag_type", path, errno);
    if (tag != ACL_EXTENDED_ALLOW && tag != ACL_EXTENDED_DENY) fail("acl-unknown-tag", path, EINVAL);
    void *qualifier = acl_get_qualifier(entry);
    if (!qualifier) fail("acl_get_qualifier", path, errno);
    id_t ident = 0;
    int idtype = -1;
    int result = mbr_uuid_to_id(*(const uuid_t *)qualifier, &ident, &idtype);
    acl_free(qualifier);
    if (result != 0) fail("mbr_uuid_to_id", path, result);
    if (idtype != ID_TYPE_UID && idtype != ID_TYPE_GID) fail("acl-unknown-principal-type", path, EINVAL);
    acl_permset_mask_t raw = 0;
    if (acl_get_permset_mask_np(entry, &raw) != 0) fail("acl_get_permset_mask_np", path, errno);
    if (raw & ~(holdr_known_rights() | HOLDR_GENERIC_BITS)) fail("acl-unknown-rights-bits", path, EINVAL);
    acl_permset_mask_t expanded = holdr_expand(raw);
    acl_flagset_t flags;
    if (acl_get_flagset_np(entry, &flags) != 0) fail("acl_get_flagset_np", path, errno);
    fprintf(out, "%s{\"type\":\"%s\",\"principal\":\"%s\",\"id\":%u,\"mask\":\"0x%llx\",\"generic\":[",
            i ? "," : "", tag == ACL_EXTENDED_ALLOW ? "allow" : "deny", idtype == ID_TYPE_UID ? "uid" : "gid",
            (unsigned)ident, (unsigned long long)raw);
    int first = 1;
    for (size_t k = 0; k < sizeof HOLDR_GENERICS / sizeof HOLDR_GENERICS[0]; k++) {
      if (raw & HOLDR_GENERICS[k].bit) { fprintf(out, "%s\"%s\"", first ? "" : ",", HOLDR_GENERICS[k].name); first = 0; }
    }
    fprintf(out, "],\"perms\":[");
    first = 1;
    for (size_t k = 0; k < sizeof HOLDR_RIGHTS / sizeof HOLDR_RIGHTS[0]; k++) {
      if (expanded & HOLDR_RIGHTS[k].bit) { fprintf(out, "%s\"%s\"", first ? "" : ",", HOLDR_RIGHTS[k].name); first = 0; }
    }
    fprintf(out, "],\"flags\":[");
    first = 1;
    for (size_t k = 0; k < sizeof HOLDR_FLAGS / sizeof HOLDR_FLAGS[0]; k++) {
      int present = acl_get_flag_np(flags, HOLDR_FLAGS[k].flag);
      if (present < 0) fail("acl_get_flag_np", path, errno);
      if (present) { fprintf(out, "%s\"%s\"", first ? "" : ",", HOLDR_FLAGS[k].name); first = 0; }
    }
    fprintf(out, "]}");
  }
  fprintf(out, "]");
}
#endif
