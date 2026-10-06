defmodule Vc.Application do
  @moduledoc false

  use Application

  @impl true
  def start(_type, _args) do
    port = String.to_integer(System.get_env("PORT") || "8081")
    Vc.Metrics.init()

    children = [
      Vc.Rooms,
      {Bandit, plug: Vc.Router, port: port}
    ]

    opts = [strategy: :one_for_one, name: Vc.Supervisor]
    Supervisor.start_link(children, opts)
  end
end
