"""Runner Python per tensorflowjs_converter che stubbba shape_poly mancante
in jax 0.4.18+. Uso:
    py -3.11 scripts/tfjs_runner.py <args...>
"""
import sys

# Patch jax.experimental.jax2tf: aggiungi shape_poly finto se manca
try:
    import jax.experimental.jax2tf as _j2t
    if not hasattr(_j2t, 'shape_poly'):
        import types
        _sp = types.ModuleType('shape_poly')
        # minimi attributi richiesti da tfjs.converters.jax_conversion
        class _InconclusiveErr(Exception):
            pass
        class _PolyShape:
            def __init__(self, *a, **kw): pass
        _sp.InconclusiveDimensionOperation = _InconclusiveErr
        _sp.PolyShape = _PolyShape
        _j2t.shape_poly = _sp
except Exception as e:
    print(f"[tfjs_runner] warn patch shape_poly: {e}", file=sys.stderr)

# Delega al converter originale.
# Chiamiamo direttamente `convert(args_list)` perché main() del tfjs è
# scritto in modo anomalo (fa argv[0].split(' ') invece di argparse).
from tensorflowjs.converters.converter import convert
if __name__ == '__main__':
    convert(sys.argv[1:])
