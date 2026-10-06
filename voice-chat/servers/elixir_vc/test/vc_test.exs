defmodule VcTest do
  use ExUnit.Case
  doctest Vc

  test "greets the world" do
    assert Vc.hello() == :world
  end
end
