;; 2nd callee for the polymorphic variant (different body -> distinct fn).
(module
  (func (export "m") (param f64) (result f64)
    (f64.mul (local.get 0) (f64.const 1.0000001))))
