import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { OBJLoader } from 'three/addons/loaders/OBJLoader.js';

 // --- Global State ---
let renderer, scene;
let observerCamera, scannerCamera; // Two cameras
let controls;
let activeCamera; // The one currently rendering to screen
let scannerHelper;

// The objects
let pointCloudGroup = new THREE.Group(); // The visible scatter plot

// Original vertex data (in local space) for visibility filtering
let basePositions = null;
let baseNormals = null;

// Uniform values for shader (kept for potential future use)
const scannerViewMatrix = new THREE.Matrix4();
const scannerProjectionMatrix = new THREE.Matrix4();

// Reusable helpers (moved to top to prevent ReferenceError)
const _scannerFrustum = new THREE.Frustum();
const _projScreenMatrix = new THREE.Matrix4();
const _tmpLocal = new THREE.Vector3();
const _tmpWorld = new THREE.Vector3();
const _tmpNormal = new THREE.Vector3();
const _viewDir = new THREE.Vector3();

function init() {
    const container = document.getElementById('canvas-container');

    // 1. WebGPU Renderer Setup
    renderer = new THREE.WebGPURenderer({ antialias: true });
    renderer.setPixelRatio(window.devicePixelRatio);
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.setClearColor(0x111111);
    container.appendChild(renderer.domElement);

    // 2. Scene Setup
    scene = new THREE.Scene();

    // 3. Camera Setup
    
    // Observer Camera (User moves this one)
    observerCamera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.1, 100);
    observerCamera.position.set(4, 3, 4);

    // Scanner Camera (The "Projector" / "Eye")
    scannerCamera = new THREE.PerspectiveCamera(45, 1, 0.5, 20); // Square aspect for depth map usually
    scannerCamera.position.set(0, 0, 5); 
    scannerCamera.lookAt(0, 0, 0);
    
    // Create a visual representation of the scanner
    scannerHelper = new THREE.CameraHelper(scannerCamera);
    scene.add(scannerHelper);

    activeCamera = observerCamera;

    // 4. Controls
    controls = new OrbitControls(observerCamera, renderer.domElement);
    controls.enableDamping = true;

    // 5. Lighting (Just for the debug solid mesh if we ever viewed it)
    const ambient = new THREE.AmbientLight(0xffffff, 0.5);
    scene.add(ambient);
    const dirLight = new THREE.DirectionalLight(0xffffff, 1);
    dirLight.position.set(5, 10, 7);
    scene.add(dirLight);

    // 6. Initial Test Object
    loadTestObject();

    // 8. Event Listeners
    window.addEventListener('resize', onWindowResize);
    document.getElementById('toggle-view-btn').addEventListener('click', toggleCamera);
    document.getElementById('file-input').addEventListener('change', handleFileUpload);
}

function loadTestObject() {
    const geometry = new THREE.TorusKnotGeometry(1, 0.3, 150, 20);
    processGeometry(geometry);
}

// Convert Geometry to Scatter Plot + Solid Occluder
function processGeometry(geometry) {
    // Clear old objects
    pointCloudGroup.clear();
    
    // Ensure we are not adding duplicates if this function is called multiple times
    scene.remove(pointCloudGroup);

    // Center geometry
    geometry.center();

    // 1. Create Point Cloud (Scatter Plot)
    const pointGeo = new THREE.BufferGeometry();
    pointGeo.setAttribute('position', geometry.getAttribute('position'));

    // Store original positions for visibility filtering
    const srcAttr = pointGeo.getAttribute('position');
    basePositions = new Float32Array(srcAttr.array.length);
    basePositions.set(srcAttr.array);

    // Store normals for backface culling
    const normAttr = geometry.getAttribute('normal');
    if (normAttr) {
        baseNormals = new Float32Array(normAttr.array.length);
        baseNormals.set(normAttr.array);
    } else {
        baseNormals = null;
    }

    const pointMat = createRaycastMaterial();
    
    const points = new THREE.Points(pointGeo, pointMat);
    pointCloudGroup.add(points);
    scene.add(pointCloudGroup);
}

function createRaycastMaterial() {
    const material = new THREE.PointsMaterial({
        color: 0x00ffff,
        size: 0.03,
        sizeAttenuation: true
    });

    return material;
}

function handleFileUpload(event) {
    const file = event.target.files[0];
    if (!file) return;

    const url = URL.createObjectURL(file);
    const ext = file.name.split('.').pop().toLowerCase();

    const loader = ext === 'obj' ? new OBJLoader() : new GLTFLoader();

    loader.load(url, (result) => {
        const object = ext === 'obj' ? result : result.scene;
        
        // Find the first mesh or merge geometries
        let geometries = [];
        object.traverse((child) => {
            if (child.isMesh) {
                geometries.push(child.geometry.clone().applyMatrix4(child.matrixWorld));
            }
        });

        if (geometries.length > 0) {
            // Simple merge if multiple meshes (BufferGeometryUtils would be better but keeping deps low)
            // Just taking the largest for simplicity or the first one
            // Ideally we merge, but for this demo, let's just grab the first valid one.
            processGeometry(geometries[0]); 
        }
        
        URL.revokeObjectURL(url);
    });
}

function toggleCamera() {
    if (activeCamera === observerCamera) {
        activeCamera = scannerCamera;
        controls.object = scannerCamera;
        scannerHelper.visible = false;
        document.getElementById('status').innerText = "Viewing: Scanner Camera";
    } else {
        activeCamera = observerCamera;
        controls.object = observerCamera;
        scannerHelper.visible = true;
        document.getElementById('status').innerText = "Viewing: Observer Camera";
    }
}

function onWindowResize() {
    const width = window.innerWidth;
    const height = window.innerHeight;

    observerCamera.aspect = width / height;
    observerCamera.updateProjectionMatrix();

    // Scanner aspect doesn't change with window, it's a fixed instrument,
    // but we could update it if we wanted it to match screen.
    // Let's keep scanner fixed ratio.

    renderer.setSize(width, height);
}

function updateVisiblePoints(camera) {
    if (!basePositions || pointCloudGroup.children.length === 0) return;

    const points = pointCloudGroup.children[0];
    const geometry = points.geometry;

    // Update camera matrices
    camera.updateMatrixWorld();
    camera.updateProjectionMatrix();

    // Build frustum from active camera
    _projScreenMatrix.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    _scannerFrustum.setFromProjectionMatrix(_projScreenMatrix);

    const worldMatrix = pointCloudGroup.matrixWorld;
    // Calculate normal matrix for transforming normals correctly
    const normalMatrix = new THREE.Matrix3().getNormalMatrix(worldMatrix);
    
    // Get camera position in world space
    const camPos = new THREE.Vector3();
    camera.getWorldPosition(camPos);

    // Allocate a buffer to store only the visible vertices
    const visiblePositions = new Float32Array(basePositions.length);
    let ptr = 0;

    for (let i = 0; i < basePositions.length; i += 3) {
        _tmpLocal.set(
            basePositions[i],
            basePositions[i + 1],
            basePositions[i + 2]
        );

        // Compute world position for frustum test
        _tmpWorld.copy(_tmpLocal).applyMatrix4(worldMatrix);

        if (_scannerFrustum.containsPoint(_tmpWorld)) {
            
            let isVisible = true;

            // Backface Culling
            if (baseNormals) {
                // Get normal
                _tmpNormal.set(
                    baseNormals[i],
                    baseNormals[i+1],
                    baseNormals[i+2]
                );
                
                // Transform normal to world space
                _tmpNormal.applyMatrix3(normalMatrix);

                // Vector from Point to Camera
                _viewDir.subVectors(camPos, _tmpWorld);

                // If Dot Product > 0, face is visible. If < 0, it's facing away.
                if (_tmpNormal.dot(_viewDir) <= 0) {
                    isVisible = false;
                }
            }

            if (isVisible) {
                // Keep the original local-space position in the geometry
                visiblePositions[ptr] = _tmpLocal.x;
                visiblePositions[ptr + 1] = _tmpLocal.y;
                visiblePositions[ptr + 2] = _tmpLocal.z;
                ptr += 3;
            }
        }
    }

    // Resize geometry to visible subset
    const finalPositions = visiblePositions.subarray(0, ptr);
    geometry.setAttribute('position', new THREE.BufferAttribute(finalPositions, 3));
    geometry.setDrawRange(0, ptr / 3);
    geometry.attributes.position.needsUpdate = true;
}

function animate() {
    requestAnimationFrame(animate);

    controls.update();

    // Update which vertices are visible from the ACTIVE camera
    updateVisiblePoints(activeCamera);

    // Only show helper if we are observing (shows the OTHER camera)
    scannerHelper.visible = (activeCamera === observerCamera);
    if (scannerHelper.visible) scannerHelper.update();

    renderer.render(scene, activeCamera);
}

// Call init and animate only after all constants and functions are defined
init();
animate();

