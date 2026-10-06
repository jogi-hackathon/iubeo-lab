defmodule Vc.Rooms do
  @moduledoc "Room registry: room_id => %{peer_id => pid}. Single GenServer is plenty at bench scale."
  use GenServer

  def start_link(_), do: GenServer.start_link(__MODULE__, %{}, name: __MODULE__)

  @doc "join(room, id, pid) -> {:ok, existing_ids} | {:error, :full | :dup}"
  def join(room, id, pid) do
    GenServer.call(__MODULE__, {:join, room, id, pid})
  end

  def leave(room, id, pid), do: GenServer.call(__MODULE__, {:leave, room, id, pid})
  def others(room, exclude_id), do: GenServer.call(__MODULE__, {:others, room, exclude_id})
  def lookup(room, id), do: GenServer.call(__MODULE__, {:lookup, room, id})
  def counts, do: GenServer.call(__MODULE__, :counts)
  def list, do: GenServer.call(__MODULE__, :list)

  @impl true
  def init(_), do: {:ok, %{rooms: %{}}}

  @impl true
  def handle_call({:join, room, id, pid}, _from, state) do
    members = Map.get(state.rooms, room, %{})
    max = Application.get_env(:vc, :room_max, 8)

    cond do
      Map.has_key?(members, id) -> {:reply, {:error, :dup}, state}
      map_size(members) >= max -> {:reply, {:error, :full}, state}
      true ->
        existing = Map.keys(members)
        members = Map.put(members, id, pid)
        {:reply, {:ok, existing}, put_in(state.rooms[room], members)}
    end
  end

  def handle_call({:leave, room, id, pid}, _from, state) do
    members = Map.get(state.rooms, room, %{})

    state =
      case Map.get(members, id) do
        ^pid ->
          members = Map.delete(members, id)
          if members == %{},
            do: %{state | rooms: Map.delete(state.rooms, room)},
            else: put_in(state.rooms[room], members)

        _ ->
          state
      end

    {:reply, :ok, state}
  end

  def handle_call({:others, room, exclude_id}, _from, state) do
    members = Map.get(state.rooms, room, %{}) |> Map.delete(exclude_id)
    {:reply, members, state}
  end

  def handle_call({:lookup, room, id}, _from, state) do
    {:reply, get_in(state.rooms, [room, id]), state}
  end

  def handle_call(:list, _from, state) do
    rooms =
      for {name, members} <- state.rooms do
        %{name: name, members: map_size(members), ids: Map.keys(members)}
      end

    {:reply, rooms, state}
  end

  def handle_call(:counts, _from, state) do
    peers = state.rooms |> Map.values() |> Enum.map(&map_size/1) |> Enum.sum()
    {:reply, %{rooms: map_size(state.rooms), peers: peers}, state}
  end
end
