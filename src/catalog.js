// Decodes public/data/stars.bin (written by tools/build-stars.mjs).
//
// File layout: 'SFC1' | u32 header bytes | JSON header | sections (4-byte aligned):
//   nodeBounds  f32[nodes*6]  tight AABB per octree node (min xyz, max xyz), parsecs
//   nodeLinks   u32[nodes*4]  start, count, firstChild, childCount (childCount 0 = leaf)
//   qx, qy, qz  i16[stars]    position inside the leaf's AABB, scaled to +-32767
//   mag         u8[stars]     absolute V magnitude inside its band's [mMin, mMax]
//   bv          u8[stars]     B-V colour index: bv.min + q * bv.step
// Stars are grouped by absolute-magnitude band; inside a band every octree subtree is a
// contiguous index range, which is what the culling pass hands to the GPU.

export const TEX_WIDTH = 2048; // texels per row of the star texture (WebGL2 guarantees 2048)
export const PACK = 64;        // texel.w = colourIndex * PACK + (M + MAG_OFFSET)
export const MAG_OFFSET = 16;

export function parseCatalog(buffer) {
  const u8 = new Uint8Array(buffer);
  const magic = String.fromCharCode(u8[0], u8[1], u8[2], u8[3]);
  if (magic !== 'SFC1') throw new Error('stars.bin: bad magic');
  const dv = new DataView(buffer);
  const headerBytes = dv.getUint32(4, true);
  const header = JSON.parse(new TextDecoder().decode(u8.subarray(8, 8 + headerBytes)));
  const sec = (name, Type) => {
    const [off, len] = header.sections[name];
    return new Type(buffer, off, len / Type.BYTES_PER_ELEMENT);
  };
  const nodeBounds = sec('nodeBounds', Float32Array);
  const nodeLinks = sec('nodeLinks', Uint32Array);
  const qx = sec('qx', Int16Array), qy = sec('qy', Int16Array), qz = sec('qz', Int16Array);
  const qm = sec('mag', Uint8Array), qc = sec('bv', Uint8Array);
  const count = header.starCount;
  const texHeight = Math.ceil(count / TEX_WIDTH);
  const tex = new Float32Array(TEX_WIDTH * texHeight * 4);

  // Absolute magnitudes, band by band, packed with the colour index into texel.w.
  for (const band of header.bands) {
    const span = (band.mMax - band.mMin) / 255;
    for (let i = band.start, end = band.start + band.count; i < end; i++) {
      const M = band.mMin + qm[i] * span;
      tex[i * 4 + 3] = qc[i] * PACK + (M + MAG_OFFSET);
    }
  }
  // Positions, leaf by leaf.
  const inv = 1 / header.quant;
  for (let n = 0, nodes = header.nodeCount; n < nodes; n++) {
    if (nodeLinks[n * 4 + 3] !== 0) continue;
    const b = n * 6;
    const mx = (nodeBounds[b] + nodeBounds[b + 3]) / 2, hx = Math.max((nodeBounds[b + 3] - nodeBounds[b]) / 2, 1e-9);
    const my = (nodeBounds[b + 1] + nodeBounds[b + 4]) / 2, hy = Math.max((nodeBounds[b + 4] - nodeBounds[b + 1]) / 2, 1e-9);
    const mz = (nodeBounds[b + 2] + nodeBounds[b + 5]) / 2, hz = Math.max((nodeBounds[b + 5] - nodeBounds[b + 2]) / 2, 1e-9);
    for (let i = nodeLinks[n * 4], end = i + nodeLinks[n * 4 + 1]; i < end; i++) {
      tex[i * 4] = mx + qx[i] * inv * hx;
      tex[i * 4 + 1] = my + qy[i] * inv * hy;
      tex[i * 4 + 2] = mz + qz[i] * inv * hz;
    }
  }
  return {
    header, count, tex, texWidth: TEX_WIDTH, texHeight, nodeBounds, nodeLinks, bands: header.bands,
    bvMin: header.bv.min, bvStep: header.bv.step,
    position: (i) => [tex[i * 4], tex[i * 4 + 1], tex[i * 4 + 2]],
    absMag: (i) => { const w = tex[i * 4 + 3]; return w - Math.floor(w / PACK) * PACK - MAG_OFFSET; },
    colourIndex: (i) => Math.floor(tex[i * 4 + 3] / PACK),
    bv: (i) => header.bv.min + Math.floor(tex[i * 4 + 3] / PACK) * header.bv.step,
  };
}

/** names.json -> array of { index, name, designation, spectrum, note } */
export function parseNames(json) {
  return json.labels.map(([index, name, designation, spectrum, note = '']) => ({ index, name, designation, spectrum, note }));
}
