defmodule Vc.MixProject do
  use Mix.Project

  def project do
    [
      app: :vc,
      version: "0.1.0",
      elixir: "~> 1.19",
      start_permanent: Mix.env() == :prod,
      deps: deps()
    ]
  end

  # Run "mix help compile.app" to learn about applications.
  def application do
    [
      extra_applications: [:logger],
      mod: {Vc.Application, []}
    ]
  end

  # Run "mix help deps" to learn about dependencies.
  defp deps do
    [
      {:bandit, "~> 1.8"},
      {:websock_adapter, "~> 0.5"},
      {:plug, "~> 1.16"}
    ]
  end
end
