;; Variant D: cross-instance DIRECT call via a wasm import (no table).
;; The import slot is bound to another module's exported wasm function.
(module
  (import "e" "f" (func $callee (param f64) (result f64)))
  (func (export "run") (param $n i32) (param $base i32) (param $nslots i32) (result f64)
    (local $x f64)
    (loop $l
      (local.set $x (call $callee (local.get $x)))
      (br_if $l
        (i32.gt_s
          (local.tee $n (i32.sub (local.get $n) (i32.const 1)))
          (i32.const 0))))
    (local.get $x)))
