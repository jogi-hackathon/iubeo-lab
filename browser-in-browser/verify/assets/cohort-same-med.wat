;; Same-module call_indirect to a medium callee.
(module
  (type $sig (func (param f64) (result f64)))
  (table $t 8 funcref)
  (elem (i32.const 0) $callee)
  (func $callee (type $sig)
    (local $t f64)
    (local.set $t (f64.add (f64.mul (local.get 0) (f64.const 1.0000001)) (f64.const 0.5)))
    (local.set $t (f64.sub (f64.mul (local.get $t) (f64.const 0.9999999)) (f64.const 0.25)))
    (local.set $t (f64.add (f64.mul (local.get $t) (f64.const 1.0000003)) (local.get 0)))
    (local.set $t (f64.sub (f64.mul (local.get $t) (f64.const 0.5)) (f64.const 0.125)))
    (f64.add (f64.mul (local.get $t) (f64.const 1.25)) (f64.const 0.0625)))
  (func (export "run") (param $n i32) (param $base i32) (param $nslots i32) (result f64)
    (local $x f64)
    (loop $l
      (local.set $x
        (call_indirect (type $sig) (local.get $x) (i32.const 0)))
      (br_if $l
        (i32.gt_s
          (local.tee $n (i32.sub (local.get $n) (i32.const 1)))
          (i32.const 0))))
    (local.get $x)))
