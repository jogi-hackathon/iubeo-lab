defmodule Vc.Ws do
  @moduledoc "WebSock handler for /v1/signaling. Implements docs/protocol.md semantics."
  @behaviour WebSock

  @impl true
  def init(%{id: id, room: room} = _arg) do
    case Vc.Rooms.join(room, id, self()) do
      {:ok, existing} ->
        broadcast(room, id, %{type: "peer-joined", id: id})
        peers = %{type: "peers", peers: Enum.map(existing, &%{id: &1})}
        {:push, [{:text, :json.encode(peers)}], %{id: id, room: room}}

      {:error, reason} ->
        {:stop, {:shutdown, reason}, %{id: id, room: room}}
    end
  end

  @impl true
  def handle_in({data, [opcode: :binary]}, state) do
    Vc.Metrics.incr(:media_frames)
    Vc.Metrics.incr(:media_bytes, byte_size(data))

    for {_pid_id, pid} <- Vc.Rooms.others(state.room, state.id) do
      send(pid, {:send_binary, data})
    end

    {:ok, state}
  end

  def handle_in({data, [opcode: :text]}, state) do
    case :json.decode(data) do
      %{"type" => "ping", "t" => t} ->
        {:push, [{:text, :json.encode(%{type: "pong", t: t})}], state}

      %{"type" => "signal", "to" => to, "data" => payload} when is_binary(to) ->
        Vc.Metrics.incr(:signal_msgs)

        case Vc.Rooms.lookup(state.room, to) do
          pid when is_pid(pid) ->
            send(pid, {:send_text, :json.encode(%{type: "signal", from: state.id, data: payload})})
            {:ok, state}

          nil ->
            err = :json.encode(%{type: "error", code: "no_such_peer", message: to})
            {:push, [{:text, err}], state}
        end

      _ ->
        {:ok, state}
    end
  end

  @impl true
  def handle_info({:send_text, msg}, state), do: {:push, [{:text, msg}], state}
  def handle_info({:send_binary, data}, state), do: {:push, [{:binary, data}], state}

  def handle_info(_other, state), do: {:ok, state}

  @impl true
  def terminate(_reason, state) do
    Vc.Rooms.leave(state.room, state.id, self())
    broadcast(state.room, state.id, %{type: "peer-left", id: state.id})
    :ok
  end

  defp broadcast(room, exclude, msg) do
    raw = :json.encode(msg)

    for {_id, pid} <- Vc.Rooms.others(room, exclude) do
      send(pid, {:send_text, raw})
    end
  end
end
