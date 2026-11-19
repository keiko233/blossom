use super::types::{Interface, Usage};

pub(crate) trait LinuxRead {
    fn text(&self, path: &str) -> Option<String>;
    fn exists(&self, path: &str) -> bool;
    fn disk(&self) -> Option<Usage>;
    fn interfaces(&self) -> Vec<Interface>;
}
