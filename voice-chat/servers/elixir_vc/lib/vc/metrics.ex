defmodule Vc.Metrics do
  @moduledoc "Atomics counters + process stats. Fields: signal_msgs, media_frames, media_bytes."
  @names [:signal_msgs, :media_frames, :media_bytes]

  def init do
    ref = :atomics.new(3, [])
    :persistent_term.put({__MODULE__, :ref}, ref)
    ref
  end

  defp ref, do: :persistent_term.get({__MODULE__, :ref})

  def incr(name, n \\ 1) do
    idx = Enum.find_index(@names, &(&1 == name)) + 1
    :atomics.add(ref(), idx, n)
  end

  def snapshot do
    r = ref()
    {run_ms, _} = :erlang.statistics(:runtime)

    %{
      uptime_s: (System.system_time(:millisecond) - start_ts()) / 1000,
      signal_msgs_total: :atomics.get(r, 1),
      media_frames_total: :atomics.get(r, 2),
      media_bytes_total: :atomics.get(r, 3),
      rss_bytes: :erlang.memory(:total),
      cpu_s: run_ms / 1000
    }
  end

  def start_ts do
    case :persistent_term.get({__MODULE__, :started_at}, :unset) do
      :unset ->
        ts = System.system_time(:millisecond)
        :persistent_term.put({__MODULE__, :started_at}, ts)
        ts

      ts ->
        ts
    end
  end
end
