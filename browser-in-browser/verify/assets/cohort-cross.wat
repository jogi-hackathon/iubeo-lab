;; Variant A: cross-instance call_indirect through an IMPORTED shared host table.
;; Models current WJ: every JIT fn is its own module/instance; calls go through
;; the shared table so callee belongs to a DIFFERENT instance.
;; slot = base + (i % nslots)
(module
  (import "e" "t" (table $t 64 funcref))
  (type $sig (func (param f64) (result f64)))
  (func (export "run") (param $n i32) (param $base i32) (param $nslots i32) (result f64)
    (local $x f64)
    (local $i i32)
    (loop $l
      (local.set $x
        (call_indirect (type $sig)
          (local.get $x)
          (i32.add
            (local.get $base)
            (i32.rem_u (local.get $i) (local.get $nslots)))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br_if $l
        (i32.gt_s
          (local.tee $n (i32.sub (local.get $n) (i32.const 1)))
          (i32.const 0))))
    (local.get $x)))
