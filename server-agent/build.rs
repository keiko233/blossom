fn main() {
    let src = "openapi/spec.json";
    println!("cargo:rerun-if-changed={src}");

    let file = std::fs::File::open(src).expect("openapi/spec.json missing — run `pnpm agent:spec`");
    let mut spec: serde_json::Value =
        serde_json::from_reader(file).expect("failed to parse openapi/spec.json");
    // The control plane writes the spec in OAS 3.1 style: nullable fields are
    // `anyOf: [T, {type: "null"}]`. progenitor 0.14 parses schemas as OAS 3.0,
    // where nullability is the `nullable: true` keyword and `{type: "null"}`
    // is unsupported (it panics with "invalid type: null"). Normalize in-memory
    // before codegen; the checked-in spec is untouched.
    normalize_nullable(&mut spec);

    let spec: openapiv3::OpenAPI = serde_json::from_value(spec).expect("failed to decode OpenAPI");
    let mut generator = progenitor::Generator::default();
    let tokens = generator
        .generate_tokens(&spec)
        .expect("progenitor codegen failed");
    let ast = syn::parse2(tokens).expect("failed to parse generated tokens");
    let content = prettyplease::unparse(&ast);

    let mut out_file = std::path::PathBuf::from(std::env::var("OUT_DIR").unwrap());
    out_file.push("codegen.rs");
    std::fs::write(out_file, content).expect("failed to write codegen.rs");

    // Compile-time build ID. Prefer the CI/Docker-injected value (e.g. an OCI
    // revision or build arg); fall back to a short local git sha, then "local".
    let build_id = std::env::var("AGENT_BUILD_ID")
        .or_else(|_| std::env::var("BUILD_ID"))
        .ok()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(local_build_id);
    println!("cargo:rustc-env=AGENT_BUILD_ID={build_id}");
    println!("cargo:rerun-if-env-changed=AGENT_BUILD_ID");
    println!("cargo:rerun-if-env-changed=BUILD_ID");
}

fn local_build_id() -> String {
    let commit = git_short_sha().unwrap_or_default();
    if commit.is_empty() {
        "local".to_string()
    } else {
        format!("local-{commit}")
    }
}

fn git_short_sha() -> Option<String> {
    let output = std::process::Command::new("git")
        .args(["rev-parse", "--short=12", "HEAD"])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    Some(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

/// Rewrites OAS 3.1-style `anyOf: [T, {type: "null"}]` into an OAS 3.0
/// `nullable: true` schema so progenitor can generate `Option<T>`.
fn normalize_nullable(schema: &mut serde_json::Value) {
    if let serde_json::Value::Object(object) = schema {
        for (key, value) in object.iter_mut() {
            let _ = key;
            normalize_nullable(value);
        }
        let Some(items) = object.get("anyOf").and_then(|v| v.as_array()).cloned() else {
            return;
        };
        let mut non_null = Vec::new();
        let mut saw_null = false;
        for item in items {
            if item.get("type").and_then(serde_json::Value::as_str) == Some("null") {
                saw_null = true;
            } else {
                non_null.push(item);
            }
        }
        if saw_null && non_null.len() == 1 {
            object.insert("nullable".into(), serde_json::Value::Bool(true));
            object.insert(
                "anyOf".into(),
                serde_json::Value::Array(vec![non_null.pop().unwrap()]),
            );
        }
    }
}
