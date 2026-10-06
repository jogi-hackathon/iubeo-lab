defmodule Vc.Router do
  @moduledoc "HTTP routes: /v1/signaling (WS upgrade), /v1/moq/auth (moq-relay auth webhook), /healthz, /metrics."
  use Plug.Router
  require Logger

  plug :match
  plug :dispatch

  get "/healthz" do
    json(conn, 200, %{ok: true})
  end

  get "/metrics" do
    counts = Vc.Rooms.counts()
    s = Vc.Metrics.snapshot()

    json(
      conn,
      200,
      Map.merge(s, %{
        ws_connections: counts.peers,
        rooms: counts.rooms,
        peers: counts.peers
      })
    )
  end

  # Live room list for the lobby page — empty rooms vanish from the roster
  # automatically, so this is exactly "rooms you can walk into right now".
  get "/v1/rooms" do
    conn
    |> put_resp_header("access-control-allow-origin", "*")
    |> json(200, %{rooms: Vc.Rooms.list()})
  end

  # Open join for the world demo: any caller gets a roster-unique id + its
  # JWT — "open the page and you're in". Dev/demo endpoint (no auth of its
  # own; the room-scoped relay grant still applies downstream).
  options "/v1/join" do
    conn
    |> put_resp_header("access-control-allow-origin", "*")
    |> put_resp_header("access-control-allow-methods", "POST, OPTIONS")
    |> put_resp_header("access-control-allow-headers", "content-type")
    |> send_resp(204, "")
  end

  post "/v1/join" do
    {:ok, body, conn} = Plug.Conn.read_body(conn)

    with {:ok, req} <- safe_json(body),
         room when is_binary(room) <- req["room"],
         :ok <- check_room(room),
         {:ok, id} <- pick_id(room, req["name"]) do
      conn
      |> put_resp_header("access-control-allow-origin", "*")
      |> json(200, %{id: id, token: Vc.Jwt.sign(id, room)})
    else
      :full -> json(conn, 409, %{error: "room_full"})
      :bad_room -> json(conn, 400, %{error: "bad_room"})
      _ -> json(conn, 400, %{error: "bad_request"})
    end
  end

  get "/v1/signaling" do
    conn = fetch_query_params(conn)

    case conn.query_params["token"] do
      nil ->
        json(conn, 401, %{error: "unauthorized"})

      token ->
        case Vc.Jwt.verify(token, Vc.Jwt.public_key()) do
          {:ok, claims} ->
            conn
            |> WebSockAdapter.upgrade(Vc.Ws, %{id: claims["sub"], room: claims["room"]}, [])
            |> halt()

          :error ->
            json(conn, 401, %{error: "unauthorized"})
        end
    end
  end

  # moq-relay --auth-url webhook: POSTed once per session event.
  # "connect"/"revalidate" must return a grant (publish/subscribe path
  # patterns, expires, revalidate); "end" is a notification.
  post "/v1/moq/auth" do
    {:ok, body, conn} = Plug.Conn.read_body(conn)

    case :json.decode(body) do
      %{"event" => "end"} ->
        json(conn, 200, %{})

      %{"event" => event, "query" => query} when event in ["connect", "revalidate"] ->
        jwt = URI.decode_query(query || "")["jwt"]

        with token when is_binary(token) <- jwt,
             {:ok, claims} <- Vc.Jwt.verify(token, Vc.Jwt.public_key()),
             true <- event == "connect" or member?(claims) do
          # the media session may publish only its own broadcast and may
          # subscribe only inside its room; revalidate drops the session
          # once the peer has left the roster (kick enforcement)
          json(conn, 200, %{
            publish: ["vc-bench/#{claims["room"]}/#{claims["sub"]}"],
            subscribe: ["vc-bench/#{claims["room"]}/*"],
            expires: claims["exp"],
            revalidate: 60
          })
        else
          reason ->
            Logger.warning("moq auth refused: event=#{event} reason=#{inspect(reason)}")
            send_resp(conn, 403, "")
        end

      _ ->
        send_resp(conn, 400, "")
    end
  end

  match _ do
    json(conn, 404, %{error: "not_found"})
  end

  defp member?(claims), do: is_pid(Vc.Rooms.lookup(claims["room"], claims["sub"]))

  # Room names land inside the relay's media namespace (vc-bench/<room>/…),
  # so forbid separators that could cross scope — keep it a flat label.
  defp check_room(room),
    do: if(Regex.match?(~r/^[^\s\/\\]{1,32}$/u, room), do: :ok, else: :bad_room)

  defp pick_id(room, name) do
    max = Application.get_env(:vc, :room_max, 8)

    if map_size(Vc.Rooms.others(room, "")) >= max do
      :full
    else
      base =
        case name do
          n when is_binary(n) ->
            s = n |> String.trim() |> String.slice(0, 24)
            if s == "", do: rand_id(), else: s

          _ ->
            rand_id()
        end

      Enum.find_value(0..19, fn i ->
        cand = if i == 0, do: base, else: "#{base}-#{i + 1}"
        if is_nil(Vc.Rooms.lookup(room, cand)), do: cand
      end)
      |> case do
        nil -> :full
        id -> {:ok, id}
      end
    end
  end

  defp rand_id, do: "p-" <> Base.url_encode64(:crypto.strong_rand_bytes(3), padding: false)

  defp safe_json(body) do
    {:ok, :json.decode(body)}
  rescue
    _ -> :error
  end

  defp json(conn, status, body) do
    conn
    |> put_resp_content_type("application/json")
    |> send_resp(status, :json.encode(body))
  end
end
