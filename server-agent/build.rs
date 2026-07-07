fn main() {
    let src = "openapi/spec.json";
    println!("cargo:rerun-if-changed={src}");

    let file = std::fs::File::open(src).expect("openapi/spec.json missing — run `pnpm agent:spec`");
    let spec = serde_json::from_reader(file).expect("failed to parse openapi/spec.json");

    let mut generator = progenitor::Generator::default();
    let tokens = generator
        .generate_tokens(&spec)
        .expect("progenitor codegen failed");
    let ast = syn::parse2(tokens).expect("failed to parse generated tokens");
    let content = prettyplease::unparse(&ast);

    let mut out_file = std::path::PathBuf::from(std::env::var("OUT_DIR").unwrap());
    out_file.push("codegen.rs");
    std::fs::write(out_file, content).expect("failed to write codegen.rs");
}
