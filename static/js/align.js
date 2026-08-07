"use strict";

/*
  Point-cloud Kabsch alignment. This is a different problem from the
  axis-alignment Kabsch in xyzalign-web's align.js (which rotates single
  centroid *directions* onto the X/Y/Z axes): here we rotate a whole set
  of N points P onto a corresponding set of N points Q, minimizing
  sum_i |R*P_i - Q_i|^2. This is a direct port of xyzoverlay.py's
  kabsch(P, Q) / align_xyz():

    C = P^T Q
    V, S, W = svd(C)          # numpy: C = V @ diag(S) @ W
    d = sign(det(V) * det(W))
    U = V @ diag(1,1,d) @ W   # proper rotation, no reflection
    aligned = coord @ U

  The 3x3 SVD (via eigendecomposition of C^T C) is the same generic
  routine used in xyzalign-web, just not gated behind per-vector
  unit-normalization (point-cloud Kabsch needs the raw, weighted
  centered coordinates, not normalized direction vectors).
*/
window.XO_ALIGN = (() => {
  function matMul(A, B) {
    const R = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
    for (let i = 0; i < 3; i++)
      for (let j = 0; j < 3; j++) {
        let s = 0;
        for (let k = 0; k < 3; k++) s += A[i][k] * B[k][j];
        R[i][j] = s;
      }
    return R;
  }
  function transpose(A) {
    return [[A[0][0], A[1][0], A[2][0]], [A[0][1], A[1][1], A[2][1]], [A[0][2], A[1][2], A[2][2]]];
  }
  function identity() { return [[1, 0, 0], [0, 1, 0], [0, 0, 1]]; }
  function det3(A) {
    return A[0][0] * (A[1][1] * A[2][2] - A[1][2] * A[2][1])
      - A[0][1] * (A[1][0] * A[2][2] - A[1][2] * A[2][0])
      + A[0][2] * (A[1][0] * A[2][1] - A[1][1] * A[2][0]);
  }

  // Cyclic Jacobi eigensolver for symmetric 3x3 matrices (eigenvalues
  // descending, eigenvectors as columns of `vectors`).
  function jacobiEigenSymmetric3x3(Ain) {
    const a = Ain.map((row) => row.slice());
    const v = identity();
    for (let iter = 0; iter < 100; iter++) {
      const off = Math.abs(a[0][1]) + Math.abs(a[0][2]) + Math.abs(a[1][2]);
      if (off < 1e-14) break;
      for (let p = 0; p < 2; p++) {
        for (let q = p + 1; q < 3; q++) {
          if (Math.abs(a[p][q]) < 1e-15) continue;
          const theta = (a[q][q] - a[p][p]) / (2 * a[p][q]);
          const tSign = theta >= 0 ? 1 : -1;
          const t = tSign / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
          const c = 1 / Math.sqrt(t * t + 1);
          const s = t * c;
          const app = a[p][p], aqq = a[q][q], apq = a[p][q];
          a[p][p] = app - t * apq;
          a[q][q] = aqq + t * apq;
          a[p][q] = 0; a[q][p] = 0;
          for (let k = 0; k < 3; k++) {
            if (k !== p && k !== q) {
              const akp = a[k][p], akq = a[k][q];
              a[k][p] = c * akp - s * akq; a[p][k] = a[k][p];
              a[k][q] = s * akp + c * akq; a[q][k] = a[k][q];
            }
          }
          for (let k = 0; k < 3; k++) {
            const vkp = v[k][p], vkq = v[k][q];
            v[k][p] = c * vkp - s * vkq;
            v[k][q] = s * vkp + c * vkq;
          }
        }
      }
    }
    const eigenvalues = [a[0][0], a[1][1], a[2][2]];
    const idx = [0, 1, 2].sort((i, j) => eigenvalues[j] - eigenvalues[i]);
    const sortedVals = idx.map((i) => eigenvalues[i]);
    const sortedVecs = identity();
    for (let col = 0; col < 3; col++) for (let row = 0; row < 3; row++) sortedVecs[row][col] = v[row][idx[col]];
    return { values: sortedVals, vectors: sortedVecs };
  }

  function completeOrthonormalBasis(cols) {
    const result = cols.slice();
    const candidates = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
    for (let i = 0; i < 3; i++) {
      if (result[i]) continue;
      let found = null;
      for (const cand of candidates) {
        let vec = cand.slice();
        for (let k = 0; k < 3; k++) {
          if (result[k] && k !== i) {
            const dp = vec[0] * result[k][0] + vec[1] * result[k][1] + vec[2] * result[k][2];
            vec = [vec[0] - dp * result[k][0], vec[1] - dp * result[k][1], vec[2] - dp * result[k][2]];
          }
        }
        const n = Math.sqrt(vec[0] * vec[0] + vec[1] * vec[1] + vec[2] * vec[2]);
        if (n > 1e-6) { found = vec.map((x) => x / n); break; }
      }
      result[i] = found;
    }
    return result;
  }

  // B = U * diag(singVals) * V^T
  function svd3x3(B) {
    const M = matMul(transpose(B), B);
    const eig = jacobiEigenSymmetric3x3(M);
    const V = eig.vectors;
    const singVals = eig.values.map((x) => Math.sqrt(Math.max(x, 0)));
    const tol = 1e-9 * (singVals[0] || 1);

    let Ucols = [null, null, null];
    for (let i = 0; i < 3; i++) {
      if (singVals[i] > tol) {
        const Vi = [V[0][i], V[1][i], V[2][i]];
        const BVi = [
          B[0][0] * Vi[0] + B[0][1] * Vi[1] + B[0][2] * Vi[2],
          B[1][0] * Vi[0] + B[1][1] * Vi[1] + B[1][2] * Vi[2],
          B[2][0] * Vi[0] + B[2][1] * Vi[1] + B[2][2] * Vi[2]
        ];
        const n = Math.sqrt(BVi[0] * BVi[0] + BVi[1] * BVi[1] + BVi[2] * BVi[2]);
        Ucols[i] = n > 1e-12 ? BVi.map((x) => x / n) : null;
      }
    }
    Ucols = completeOrthonormalBasis(Ucols);
    const U = [
      [Ucols[0][0], Ucols[1][0], Ucols[2][0]],
      [Ucols[0][1], Ucols[1][1], Ucols[2][1]],
      [Ucols[0][2], Ucols[1][2], Ucols[2][2]]
    ];
    return { U, V, singVals };
  }

  function centroid(points) {
    const n = points.length;
    const s = [0, 0, 0];
    for (const p of points) { s[0] += p[0]; s[1] += p[1]; s[2] += p[2]; }
    return [s[0] / n, s[1] / n, s[2] / n];
  }

  function centroidOfAtoms(atoms) {
    return centroid(atoms.map((a) => [a.x, a.y, a.z]));
  }

  function subtractPoint(atoms, origin) {
    return atoms.map((a) => ({ ...a, x: a.x - origin[0], y: a.y - origin[1], z: a.z - origin[2] }));
  }

  // row @ M   (numpy row-vector convention, matches coord @ rotmatrix)
  function applyRowMatrix(atoms, M) {
    return atoms.map((a) => {
      const row = [a.x, a.y, a.z];
      const newRow = [0, 0, 0];
      for (let j = 0; j < 3; j++) {
        let s = 0;
        for (let k = 0; k < 3; k++) s += row[k] * M[k][j];
        newRow[j] = s;
      }
      return { ...a, x: newRow[0], y: newRow[1], z: newRow[2] };
    });
  }

  // Direct port of xyzoverlay.py kabsch(P, Q): returns the proper
  // rotation matrix U such that (P_i . U) ~= Q_i in a least-squares
  // sense, for centered point sets P, Q of equal length (>= 3, non-
  // degenerate; 1-2 points or collinear points fall back gracefully
  // via completeOrthonormalBasis but won't fully constrain the fit).
  function kabsch(P, Q) {
    let B = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
    for (let i = 0; i < P.length; i++) {
      for (let a = 0; a < 3; a++) {
        for (let b = 0; b < 3; b++) {
          B[a][b] += P[i][a] * Q[i][b];
        }
      }
    }
    const { U, V } = svd3x3(B);
    const d = det3(U) * det3(V) < 0 ? -1 : 1;
    const D = [[1, 0, 0], [0, 1, 0], [0, 0, d]];
    return matMul(matMul(U, D), transpose(V));
  }

  /*
    Aligns `atoms` (a full molecule) onto a reference, using the atom
    subsets `movingSubset`/`refSubset` (arrays of {x,y,z}, same length,
    in corresponding order) to compute the rotation. Both the molecule
    and the subset are first centered on the subset's own centroid
    (matches xyzoverlay.py: centroid is taken from the *selected* atoms,
    not all atoms, then subtracted from the whole molecule).
    refCentroid: the reference molecule's target centroid (usually
    [0,0,0] if the reference was already centered the same way).
  */
  function overlayOnto(atoms, movingSubset, refSubset, refCentroid = [0, 0, 0]) {
    const P0 = centroid(movingSubset.map((a) => [a.x, a.y, a.z]));
    const centeredAtoms = subtractPoint(atoms, P0);
    const centeredMoving = movingSubset.map((a) => [a.x - P0[0], a.y - P0[1], a.z - P0[2]]);
    const centeredRef = refSubset.map((a) => [a.x - refCentroid[0], a.y - refCentroid[1], a.z - refCentroid[2]]);
    const R = kabsch(centeredMoving, centeredRef);
    const rotated = applyRowMatrix(centeredAtoms, R);
    // place at the reference centroid so all overlaid molecules share
    // the same anchor point in space
    return subtractPoint(rotated, [-refCentroid[0], -refCentroid[1], -refCentroid[2]]);
  }

  return {
    kabsch, overlayOnto, centroid, centroidOfAtoms, subtractPoint, applyRowMatrix,
    det3, matMul, transpose, svd3x3
  };
})();
