/**
 * 场景素材：材质表 + 几个几何助手。
 *
 * 从 three-models 那套精简过来，只留这个应用用得到的；
 * 与原版的区别是**单位是米**（真机量级），不是演示尺度。
 */
import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';

export function createKit() {
	const std = (o: THREE.MeshStandardMaterialParameters) => new THREE.MeshStandardMaterial(o);
	const phys = (o: THREE.MeshPhysicalMaterialParameters) => new THREE.MeshPhysicalMaterial(o);

	const mat = {
		paint: phys({ color: 0xff6a2a, metalness: 0.3, roughness: 0.3, clearcoat: 1, clearcoatRoughness: 0.12 }),
		shell: phys({ color: 0xf2f4f7, metalness: 0.15, roughness: 0.35, clearcoat: 0.8 }),
		steel: std({ color: 0xb9c0c9, metalness: 1.0, roughness: 0.28 }),
		darkSteel: std({ color: 0x474e57, metalness: 0.9, roughness: 0.42 }),
		graphite: std({ color: 0x23272d, metalness: 0.55, roughness: 0.55 }),
		accent: std({ color: 0x2ee6a8, emissive: 0x0d7a58, emissiveIntensity: 1.1, metalness: 0.4, roughness: 0.35 }),
		rubber: std({ color: 0x15171b, metalness: 0.0, roughness: 0.95 }),
		board: std({ color: 0x0d5a3d, metalness: 0.2, roughness: 0.55 }),
		chip: std({ color: 0x1a1d21, metalness: 0.3, roughness: 0.5 }),
		gold: std({ color: 0xd8b23a, metalness: 1.0, roughness: 0.3 }),
		wood: std({ color: 0x1a1d21, metalness: 0.1, roughness: 0.6 }),
	};

	function box(w: number, h: number, d: number, r: number, material: THREE.Material, segments = 3) {
		const radius = Math.min(r, Math.min(w, h, d) / 2 - 1e-5);
		const mesh = new THREE.Mesh(new RoundedBoxGeometry(w, h, d, segments, Math.max(radius, 1e-5)), material);
		mesh.castShadow = true;
		mesh.receiveShadow = true;
		return mesh;
	}

	function cyl(rTop: number, rBottom: number, h: number, material: THREE.Material, segments = 20) {
		const mesh = new THREE.Mesh(new THREE.CylinderGeometry(rTop, rBottom, h, segments), material);
		mesh.castShadow = true;
		mesh.receiveShadow = true;
		return mesh;
	}

	return { THREE, mat, box, cyl };
}

export type Kit = ReturnType<typeof createKit>;
