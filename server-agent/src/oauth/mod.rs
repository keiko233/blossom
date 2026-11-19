//! OAuth machine identity: one-time enrollment and the client-credentials
//! token lifecycle used by the protocol v2 WebSocket.
//!
//! The enrollment command reads a one-line `egr_...` grant from a protected
//! file and writes the redemption response verbatim to a `0600` credential
//! file. The service reads that file, requests short-lived access tokens from
//! the configured Better Auth endpoint, and refreshes them before expiry.
//! Client secrets and issued tokens are registered for log redaction before
//! they are used; neither is ever printed.

mod credentials;
mod enroll;
mod http;
mod provider;

pub(crate) use enroll::{EnrollArgs, run_enroll};
pub(crate) use provider::OAuthTokenProvider;
