use std::{
    ffi::CStr,
    fs::File,
    io::Read,
    mem::MaybeUninit,
    net::{Ipv4Addr, Ipv6Addr},
    path::Path,
    ptr,
};

use super::{
    ports::LinuxRead,
    types::{Interface, Usage},
};

pub(crate) struct Linux;

impl LinuxRead for Linux {
    fn text(&self, path: &str) -> Option<String> {
        const MAX_BYTES: u64 = 512 * 1024;
        let mut value = String::new();
        File::open(path)
            .ok()?
            .take(MAX_BYTES + 1)
            .read_to_string(&mut value)
            .ok()?;
        (value.len() as u64 <= MAX_BYTES).then_some(value)
    }

    fn exists(&self, path: &str) -> bool {
        Path::new(path).exists()
    }

    // The libc field widths vary across Linux ABIs.
    #[allow(clippy::unnecessary_cast)]
    fn disk(&self) -> Option<Usage> {
        let mut stats = MaybeUninit::<libc::statvfs>::uninit();
        // SAFETY: the path is NUL-terminated and stats points to writable storage.
        if unsafe { libc::statvfs(c"/".as_ptr(), stats.as_mut_ptr()) } != 0 {
            return None;
        }
        // SAFETY: statvfs initialized the struct on success.
        let stats = unsafe { stats.assume_init() };
        Some(Usage {
            used: (stats.f_blocks.saturating_sub(stats.f_bfree) as u64)
                .saturating_mul(stats.f_frsize as u64),
            total: (stats.f_blocks as u64).saturating_mul(stats.f_frsize as u64),
        })
    }

    fn interfaces(&self) -> Vec<Interface> {
        let mut head = ptr::null_mut();
        // SAFETY: head is initialized writable storage for the returned list.
        if unsafe { libc::getifaddrs(&mut head) } != 0 {
            return Vec::new();
        }
        let mut interfaces = Vec::new();
        let mut current = head;
        // SAFETY: entries and names are owned by the list until freeifaddrs.
        unsafe {
            for _ in 0..2048 {
                let Some(entry) = current.as_ref() else { break };
                current = entry.ifa_next;
                let Some(address) = entry.ifa_addr.as_ref() else {
                    continue;
                };
                let address = match i32::from(address.sa_family) {
                    libc::AF_INET => {
                        let address = &*entry.ifa_addr.cast::<libc::sockaddr_in>();
                        Ipv4Addr::from(address.sin_addr.s_addr.to_ne_bytes()).to_string()
                    }
                    libc::AF_INET6 => {
                        let address = &*entry.ifa_addr.cast::<libc::sockaddr_in6>();
                        Ipv6Addr::from(address.sin6_addr.s6_addr).to_string()
                    }
                    _ => continue,
                };
                let Ok(name) = CStr::from_ptr(entry.ifa_name).to_str() else {
                    continue;
                };
                if name.len() <= 32
                    && !name
                        .chars()
                        .any(|ch| ch.is_whitespace() || ch.is_control() || ch == '/')
                {
                    interfaces.push(Interface {
                        name: name.to_owned(),
                        address,
                    });
                }
                if interfaces.len() == 129 {
                    break;
                }
            }
            libc::freeifaddrs(head);
        }
        interfaces.sort_unstable();
        interfaces.dedup();
        interfaces
    }
}
