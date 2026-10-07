;; Variant C: same-module DIRECT call (upper bound -- what a cohort module
;; can emit for statically known edges).
(module
  (func $callee (param f64) (result f64)
    (f64.add (local.get 0) (f64.const 1)))
  (func (export "run") (param $n i32) (param $base i32) (param $nslots i32) (result f64)
    (local $x f64)
    (loop $l
      (local.set $x (call $callee (local.get $x)))
      (br_if $l
        (i32.gt_s
          (local.tee $n (i32.sub (local.get $n) (i32.const 1)))
          (i32.const 0))))
    (local.get $x)))
