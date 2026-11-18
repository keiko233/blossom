use serde::Serialize;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Usage {
    pub used: u64,
    pub total: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Sample {
    pub cpu_percent: Option<f64>,
    pub memory: Option<Usage>,
    pub disk: Option<Usage>,
    pub environment: &'static str,
    pub network_scope: &'static str,
    pub cgroup_version: Option<u8>,
    pub cpu_limit: Option<f64>,
    pub memory_limit: Option<u64>,
}

#[derive(Serialize, Eq, Ord, PartialEq, PartialOrd)]
pub(super) struct Listener {
    pub protocol: &'static str,
    pub address: String,
    pub port: u16,
}

#[derive(Serialize, Eq, Ord, PartialEq, PartialOrd)]
pub(super) struct Interface {
    pub name: String,
    pub address: String,
}

#[derive(Serialize)]
pub(super) struct Snapshot {
    pub listeners: Vec<Listener>,
    pub interfaces: Vec<Interface>,
    pub partial: bool,
}
