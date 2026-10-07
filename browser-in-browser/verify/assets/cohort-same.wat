;; Variant B: same-instance call_indirect (cohort module, dynamic edge).
;; Caller + 3 callees live in ONE module; dispatch via the module's own table.
(module
  (type $sig (func (param f64) (result f64)))
  (table $t 8 funcref)
  (elem (i32.const 0) $c0 $c1 $c2)
  (func $c0 (type $sig) (f64.add (local.get 0) (f64.const 1)))
  (func $c1 (type $sig) (f64.mul (local.get 0) (f64.const 1.0000001)))
  (func $c2 (type $sig) (f64.sub (local.get 0) (f64.const 0.5)))
  (func (export "run") (param $n i32) (param $base i32) (param $nslots i32) (result f64)
    (local $x f64)
    (local $i i32)
    (loop $l
      (local.set $x
        (call_indirect (type $sig)
          (local.get $x)
          (i32.rem_u (local.get $i) (local.get $nslots))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br_if $l
        (i32.gt_s
          (local.tee $n (i32.sub (local.get $n) (i32.const 1)))
          (i32.const 0))))
    (local.get $x)))
