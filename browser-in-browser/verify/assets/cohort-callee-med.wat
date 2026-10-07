;; Medium-size callee (~10 f64 ops) in its own module.
(module
  (func (export "m") (param f64) (result f64)
    (local $t f64)
    (local.set $t (f64.add (f64.mul (local.get 0) (f64.const 1.0000001)) (f64.const 0.5)))
    (local.set $t (f64.sub (f64.mul (local.get $t) (f64.const 0.9999999)) (f64.const 0.25)))
    (local.set $t (f64.add (f64.mul (local.get $t) (f64.const 1.0000003)) (local.get 0)))
    (local.set $t (f64.sub (f64.mul (local.get $t) (f64.const 0.5)) (f64.const 0.125)))
    (f64.add (f64.mul (local.get $t) (f64.const 1.25)) (f64.const 0.0625))))
