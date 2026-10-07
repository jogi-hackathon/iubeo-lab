;; 3rd callee for the polymorphic variant.
(module
  (func (export "m") (param f64) (result f64)
    (f64.sub (local.get 0) (f64.const 0.5))))
