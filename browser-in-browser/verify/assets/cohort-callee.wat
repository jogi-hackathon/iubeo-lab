;; Cross-instance callee (current WJ topology: 1 function = 1 module).
(module
  (func (export "m") (param f64) (result f64)
    (f64.add (local.get 0) (f64.const 1))))
