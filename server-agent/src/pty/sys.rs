//! Linux account lookups for PTY sessions.
//!
//! The only `unsafe` in the PTY module lives here. Each call is a thin libc
//! wrapper with its preconditions stated inline.

use std::ffi::CStr;
use std::mem::MaybeUninit;

/// The effective user id of the agent process.
pub fn effective_uid() -> u32 {
    // SAFETY: geteuid(2) takes no arguments, reads no memory, and cannot fail.
    unsafe { libc::geteuid() }
}

/// The account name for `uid`, or `None` when the passwd database has no entry
/// or the lookup needs more buffer space than provided.
pub fn user_name(uid: u32) -> Option<String> {
    const BUFFER_BYTES: usize = 16 * 1024;
    let mut buffer = vec![0u8; BUFFER_BYTES];
    let mut entry = MaybeUninit::<libc::passwd>::uninit();
    let mut result: *mut libc::passwd = std::ptr::null_mut();
    // SAFETY: `entry` and `buffer` are valid for writes of the sizes given, and
    // `result` is a valid out-pointer. On success getpwuid_r sets `result` to
    // `entry` and the strings it points at live in `buffer`, which outlives the
    // read below. On failure it sets `result` to null, which is checked.
    let status = unsafe {
        libc::getpwuid_r(
            uid,
            entry.as_mut_ptr(),
            buffer.as_mut_ptr().cast(),
            buffer.len(),
            &mut result,
        )
    };
    if status != 0 || result.is_null() {
        return None;
    }
    // SAFETY: `result` is non-null and was written by a successful getpwuid_r,
    // so `pw_name` is a NUL-terminated string inside `buffer`. It is copied out
    // before `buffer` is dropped.
    let name = unsafe { CStr::from_ptr((*result).pw_name) };
    name.to_str().ok().map(str::to_owned)
}
