/* C API over otacore for JNI / ObjC / Swift. No exceptions, no C++ types.
 * Strings are UTF-8, NUL-terminated. Functions returning char* hand over a malloc'ed buffer
 * that the caller releases with otacore_free(). */
#ifndef OTACORE_C_H
#define OTACORE_C_H

#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

#define OTACORE_OK 0
#define OTACORE_IO_ERROR 1
#define OTACORE_PATCH_CORRUPT 2
#define OTACORE_HASH_MISMATCH 3
#define OTACORE_UNSUPPORTED_ALGO 4

void otacore_free(void* p);

/* sha256 of a buffer / file as "sha256:<hex>" (malloc'ed, NULL on I/O error). */
char* otacore_sha256(const void* data, size_t len);
char* otacore_sha256_file(const char* path);

/* Bucket in [0,1) for (deviceId, unit). */
double otacore_bucket(const char* device_id, const char* unit);

/* Validate manifest JSON bytes. Returns 1 if valid, else 0 and, if errors_out != NULL, a malloc'ed
 * newline-separated error list. */
int otacore_validate_manifest(const char* json, size_t len, char** errors_out);

/* Select for one unit (unit_name != NULL) or the host (unit_name == NULL).
 * supported_algos: comma-separated, e.g. "v1". running_host_id: "embedded" or a host entry id.
 * Returns malloc'ed JSON:
 *   {"source":"embedded"|"patch","reason":"...","entry":{"id","patchUrl","hash","size","updateType"}}
 * ("entry" only for source=patch). Invalid manifest => reason "invalid-manifest", source embedded.
 * Never returns NULL except on out-of-memory. */
char* otacore_select(const char* manifest_json, size_t len, const char* unit_name, double bucket,
                     const char* embedded_hash, const char* supported_algos, const char* running_host_id);

/* Apply a patch to an old file (see otacore::applyPatch). Returns OTACORE_* status. */
int otacore_apply_patch(const char* old_file, const char* patch_file, const char* out_file,
                        const char* expected_built_hash);

/* Asset-backed variant: the wrapper supplies the old data via callbacks. */
typedef struct otacore_source {
  void* ctx;
  uint64_t size;
  /* returns 1 on success, 0 on failure */
  int (*read)(void* ctx, uint64_t offset, void* buf, size_t len);
} otacore_source;
int otacore_apply_patch_source(const otacore_source* old, const char* patch_file, const char* out_file,
                               const char* expected_built_hash);

#ifdef __cplusplus
}
#endif
#endif
