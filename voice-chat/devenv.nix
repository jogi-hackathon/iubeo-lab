{ pkgs, config, ... }:

{
  # Toolchains for all VC server impls + bench rig. System stays clean.
  languages = {
    javascript = {
      enable = true;
      package = pkgs.nodejs_26;
      pnpm.enable = true;
    };
    elixir = {
      enable = true; # pulls OTP (beam) too
      package = pkgs.elixir_1_19;
    };
    rust.enable = true;
    go.enable = true;
  };

  # zig lands here until/unless it gets a languages.* module
  packages = with pkgs; [
    zig
  ];

  # keep language caches project-local (Elixir hex/mix) — no $HOME pollution
  env.MIX_HOME = "${config.devenv.root}/.devenv/state/mix";
  env.HEX_HOME = "${config.devenv.root}/.devenv/state/hex";

  enterShell = ''
    echo "vc dev env"
    echo "  node $(node --version) / pnpm $(pnpm --version)"
    echo "  elixir $(elixir --version 2>/dev/null | tail -1)"
    echo "  go $(go version | awk '{print $3}') / rust $(rustc --version | awk '{print $2}') / zig $(zig version)"
  '';
}
