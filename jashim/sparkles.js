/**
 * A copy of fractalfantasy.net/libs/press/sparkles.js for this page (images from fractalfantasy.net).
 *
 * The floating chrome sparkles behind the press, buy and linktree pages, on three.js r186
 * (WebGPU, WebGL 2 fallback). Replaces the per-page copies of three.min.js (r71),
 * OrbitControls2.js, sparkleShader.js, Sparkle.js and visceralMinds.js.
 *
 * Load after /libs/three/legacy-global.js as a text/x-after-three script. Draws into #container:
 * 2000 tetrahedra with a reflection of the studio cube map, each with a soft white
 * halo, drifting in slow circles; the view follows the mouse.
 *
 * The 4000 separate meshes of the original are two instanced meshes here.
 */

( function () {

	var T = THREE.TSL;

	// Raw colours, as three.js had them before colour management.
	THREE.ColorManagement.enabled = false;

	var COUNT = 2000;

	// pages without a #container never showed the sparkles (the old script stopped with an error)
	var container = document.getElementById( 'container' );
	if ( ! container ) return;

	var camera = new THREE.PerspectiveCamera( 45, window.innerWidth / window.innerHeight, 0.01, 100000 );
	camera.position.set( 0, 0, 10 );

	var scene = new THREE.Scene();

	// the canvas is a background: touches keep scrolling the page
	var renderer = THREE.createRenderer( { alpha: true, allowTouchScroll: true } );
	renderer.setClearColor( 0x000000, 0 );
	renderer.setPixelRatio( Math.min( window.devicePixelRatio, 2 ) );
	renderer.setSize( window.innerWidth, window.innerHeight );
	renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
	renderer.toneMapping = THREE.NoToneMapping;

	container.appendChild( renderer.domElement );

	var dir = 'https://fractalfantasy.net/libs/press/studio1/'; // the reflection images stay on fractalfantasy.net (CORS: *)
	var reflectionCube = new THREE.CubeTextureLoader().load( [ 'px', 'nx', 'py', 'ny', 'pz', 'nz' ].map( function ( n ) {

		return dir + n + '.png';

	} ) );

	var geometry = new THREE.TetrahedronGeometry( 0.1 );

	var chrome = new THREE.InstancedMesh( geometry, new THREE.MeshBasicNodeMaterial( { envMap: reflectionCube, side: THREE.DoubleSide } ), COUNT );

	// halo: white, fading out towards the silhouette (was sparkleShader.js)
	var glowMaterial = new THREE.MeshBasicNodeMaterial( { transparent: true, depthWrite: false } );
	glowMaterial.colorNode = T.vec3( 1.0 );
	glowMaterial.opacityNode = T.pow( T.max( T.dot( T.normalView, T.positionView.normalize() ).add( 1.0 ), 0.0 ), 2.0 );
	var glow = new THREE.InstancedMesh( geometry, glowMaterial, COUNT );
	glow.renderOrder = 1;

	chrome.frustumCulled = glow.frustumCulled = false;
	scene.add( chrome, glow );

	var sparkles = [];

	for ( var i = 0; i < COUNT; i ++ ) {

		sparkles.push( {

			speed: Math.random() * 0.2,
			inc: 0,
			x: - 20 + Math.random() * 60,
			y: - 20 + Math.random() * 40,
			z: - 20 + Math.random() * 40,
			rx: Math.random() * Math.PI * 2,
			ry: Math.random() * Math.PI * 2,
			rz: Math.random() * Math.PI * 2

		} );

	}

	// the camera circles the centre as the mouse moves away from the middle (was OrbitControls2.js)
	var phi = Math.PI / 2, theta = 0, mouseX = 0, mouseY = 0, radius = 10;

	document.addEventListener( 'mousemove', function ( event ) {

		mouseX = event.clientX / window.innerWidth - 0.5;
		mouseY = event.clientY / window.innerHeight - 0.5;

	} );

	window.addEventListener( 'resize', function () {

		camera.aspect = window.innerWidth / window.innerHeight;
		camera.updateProjectionMatrix();
		renderer.setSize( window.innerWidth, window.innerHeight );

	} );

	var dummy = new THREE.Object3D();
	var origin = new THREE.Vector3();
	var halo = new THREE.Vector3( 0.15, 0.15, 0.15 );
	var core = new THREE.Vector3( 0.1, 0.1, 0.1 );

	renderer.setAnimationLoop( function () {

		var spin = Date.now() * 0.001;

		for ( var i = 0; i < COUNT; i ++ ) {

			var s = sparkles[ i ];
			s.inc += s.speed * 0.01;
			dummy.position.set( s.x - Math.cos( s.inc ) * 10, s.y + Math.sin( s.inc ) * 10, s.z );
			dummy.rotation.set( s.rx + spin, s.ry + spin, s.rz + spin );
			dummy.scale.copy( core );
			dummy.updateMatrix();
			chrome.setMatrixAt( i, dummy.matrix );
			dummy.scale.copy( halo );
			dummy.updateMatrix();
			glow.setMatrixAt( i, dummy.matrix );

		}

		chrome.instanceMatrix.needsUpdate = true;
		glow.instanceMatrix.needsUpdate = true;

		phi += mouseY * Math.PI / 180;
		theta += mouseX * Math.PI / 180;
		camera.position.set( radius * Math.sin( phi ) * Math.sin( theta ), radius * Math.cos( phi ), radius * Math.sin( phi ) * Math.cos( theta ) );
		camera.lookAt( origin );

		renderer.render( scene, camera );

	} );

} )();
