defmodule Vc.Jwt do
  @moduledoc "EdDSA(Ed25519) JWT verify+mint via :crypto — docs/protocol.md auth contract."

  # Key locations. A real deployment points VC_PUBLIC_KEY_PATH /
  # VC_PRIVATE_KEY_PATH at keys generated for that host (see deploy/); the
  # committed bench/dev-keys pair is the dev-only fallback and must never be
  # used on a public server.
  defp key_path(env, name),
    do: System.get_env(env) || Path.expand("../../../../bench/dev-keys/#{name}", __DIR__)

  # Public key: "x" is the base64url raw 32B Ed25519 key.
  def public_key do
    {:ok, bin} = File.read(key_path("VC_PUBLIC_KEY_PATH", "public.jwk"))
    jwk = :json.decode(bin)
    {:ok, raw} = Base.url_decode64(Map.fetch!(jwk, "x"), padding: false)
    raw
  end

  # Private key: "d" is the 32B seed.
  defp private_key do
    {:ok, bin} = File.read(key_path("VC_PRIVATE_KEY_PATH", "private.jwk"))
    jwk = :json.decode(bin)
    {:ok, raw} = Base.url_decode64(Map.fetch!(jwk, "d"), padding: false)
    raw
  end

  @doc "Mint a dev JWT (same claims shape as bench/harness/src/keys.ts mintToken)."
  def sign(sub, room, ttl_s \\ 3600) do
    now = System.system_time(:second)
    h = b64url(:json.encode(%{alg: "EdDSA", kid: "vc-dev"}) |> IO.iodata_to_binary())
    p = b64url(:json.encode(%{room: room, iss: "vc-bench", sub: sub, iat: now, exp: now + ttl_s}) |> IO.iodata_to_binary())
    sig = :crypto.sign(:eddsa, :none, "#{h}.#{p}", [private_key(), :ed25519])
    "#{h}.#{p}.#{b64url(sig)}"
  end

  defp b64url(b), do: Base.url_encode64(b, padding: false)

  @spec verify(binary, binary) :: {:ok, map} | :error
  def verify(token, pub_raw) do
    with [h, p, s] <- String.split(token, "."),
         {:ok, header} <- b64json(h),
         true <- header["alg"] == "EdDSA",
         {:ok, payload} <- b64json(p),
         {:ok, sig} <- Base.url_decode64(s, padding: false),
         true <- :crypto.verify(:eddsa, :none, "#{h}.#{p}", sig, [pub_raw, :ed25519]),
         true <- is_number(payload["exp"]) and payload["exp"] > System.system_time(:second),
         true <- is_binary(payload["sub"]) and is_binary(payload["room"]) do
      {:ok, payload}
    else
      _ -> :error
    end
  end

  defp b64json(s) do
    with {:ok, b} <- Base.url_decode64(s, padding: false) do
      {:ok, :json.decode(b)}
    end
  rescue
    # :json.decode raises on malformed input — a bad token is a verify failure
    _ -> :error
  end
end
