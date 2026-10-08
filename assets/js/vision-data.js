/* ==========================================================================
   cdfoley.com — vision-data.js
   Shared machine vision reference data for the lens calculator and the
   vision system configurator: area-scan sensors, camera interfaces, lens
   formats and mounts, standard focal lengths, and lighting guidance.

   Sensor values are the sensor maker's full active array. Camera makers
   often crop a few rows or columns, so confirm against the camera datasheet.
   ========================================================================== */
(function () {
    'use strict';

    // id, maker, family, name, nx, ny, pitch (µm), shutter, nominal optical format (null → shown as diagonal)
    var S = [
        // Sony Pregius (global shutter)
        ['imx287', 'Sony', 'Pregius', 'IMX287', 720, 540, 6.9, 'global', '1/2.9″'],
        ['imx273', 'Sony', 'Pregius', 'IMX273', 1440, 1080, 3.45, 'global', '1/2.9″'],
        ['imx392', 'Sony', 'Pregius', 'IMX392', 1920, 1200, 3.45, 'global', '1/2.3″'],
        ['imx174', 'Sony', 'Pregius', 'IMX174', 1920, 1200, 5.86, 'global', '1/1.2″'],
        ['imx252', 'Sony', 'Pregius', 'IMX252', 2048, 1536, 3.45, 'global', '1/1.8″'],
        ['imx250', 'Sony', 'Pregius', 'IMX250', 2448, 2048, 3.45, 'global', '2/3″'],
        ['imx264', 'Sony', 'Pregius', 'IMX264', 2448, 2048, 3.45, 'global', '2/3″'],
        ['imx267', 'Sony', 'Pregius', 'IMX267', 4096, 2160, 3.45, 'global', '1″'],
        ['imx304', 'Sony', 'Pregius', 'IMX304', 4096, 3000, 3.45, 'global', '1.1″'],
        // Sony Pregius S (global shutter, back-illuminated, 2.74 µm)
        ['imx547', 'Sony', 'Pregius S', 'IMX547', 2472, 2064, 2.74, 'global', '1/1.8″'],
        ['imx546', 'Sony', 'Pregius S', 'IMX546', 2856, 2848, 2.74, 'global', '2/3″'],
        ['imx545', 'Sony', 'Pregius S', 'IMX545', 4128, 3008, 2.74, 'global', '1/1.1″'],
        ['imx542', 'Sony', 'Pregius S', 'IMX542', 5328, 3040, 2.74, 'global', '1.1″'],
        ['imx541', 'Sony', 'Pregius S', 'IMX541', 4512, 4512, 2.74, 'global', '1.1″'],
        ['imx540', 'Sony', 'Pregius S', 'IMX540', 5328, 4608, 2.74, 'global', '1.2″'],
        // Sony STARVIS and other rolling-shutter sensors
        ['imx290', 'Sony', 'STARVIS', 'IMX290', 1920, 1080, 2.9, 'rolling', '1/2.8″'],
        ['imx178', 'Sony', 'STARVIS', 'IMX178', 3072, 2048, 2.4, 'rolling', '1/1.8″'],
        ['imx334', 'Sony', 'STARVIS', 'IMX334', 3840, 2160, 2.0, 'rolling', '1/1.8″'],
        ['imx226', 'Sony', 'Exmor R', 'IMX226', 4024, 3036, 1.85, 'rolling', '1/1.7″'],
        ['imx477', 'Sony', 'Exmor R', 'IMX477', 4056, 3040, 1.55, 'rolling', '1/2.3″'],
        ['imx183', 'Sony', 'Exmor R', 'IMX183', 5472, 3648, 2.4, 'rolling', '1″'],
        // onsemi
        ['python300', 'onsemi', 'PYTHON', 'PYTHON 300', 640, 480, 4.8, 'global', '1/4″'],
        ['python1300', 'onsemi', 'PYTHON', 'PYTHON 1300', 1280, 1024, 4.8, 'global', '1/2″'],
        ['python2000', 'onsemi', 'PYTHON', 'PYTHON 2000', 1920, 1200, 4.8, 'global', '2/3″'],
        ['python5000', 'onsemi', 'PYTHON', 'PYTHON 5000', 2592, 2048, 4.8, 'global', '1″'],
        ['ar0234', 'onsemi', 'AR', 'AR0234', 1920, 1200, 3.0, 'global', '1/2.6″'],
        ['ar0521', 'onsemi', 'AR', 'AR0521', 2592, 1944, 2.2, 'rolling', '1/2.5″'],
        ['xgs12000', 'onsemi', 'XGS', 'XGS 12000', 4096, 3072, 3.2, 'global', '1″'],
        ['xgs16000', 'onsemi', 'XGS', 'XGS 16000', 4000, 4000, 3.2, 'global', '1.1″'],
        ['xgs45000', 'onsemi', 'XGS', 'XGS 45000', 8192, 5460, 3.2, 'global', null],
        // Gpixel
        ['gmax0505', 'Gpixel', 'GMAX', 'GMAX0505', 2448, 2048, 2.5, 'global', null],
        ['gmax2505', 'Gpixel', 'GMAX', 'GMAX2505', 5120, 5120, 2.5, 'global', null],
        ['gmax3265', 'Gpixel', 'GMAX', 'GMAX3265', 9344, 7000, 3.2, 'global', null],
        ['gsense2020', 'Gpixel', 'GSENSE', 'GSENSE2020BSI', 2048, 2048, 6.5, 'rolling', null],
        // ams OSRAM (CMOSIS)
        ['cmv300', 'ams OSRAM', 'CMV', 'CMV300', 648, 488, 7.4, 'global', '1/3″'],
        ['cmv2000', 'ams OSRAM', 'CMV', 'CMV2000', 2048, 1088, 5.5, 'global', null],
        ['cmv4000', 'ams OSRAM', 'CMV', 'CMV4000', 2048, 2048, 5.5, 'global', '1″'],
        ['cmv12000', 'ams OSRAM', 'CMV', 'CMV12000', 4096, 3072, 5.5, 'global', null],
        ['cmv50000', 'ams OSRAM', 'CMV', 'CMV50000', 7920, 6004, 4.6, 'global', null]
    ];

    var sensors = S.map(function (r) {
        var w = r[4] * r[6] / 1000, h = r[5] * r[6] / 1000;   // mm
        return {
            id: r[0], maker: r[1], family: r[2], name: r[3], nx: r[4], ny: r[5], pitch: r[6],
            shutter: r[7], format: r[8], width: w, height: h, diag: Math.hypot(w, h),
            mp: r[4] * r[5] / 1e6
        };
    });

    // Practical sustained payload, MB/s (10^6 bytes/s), after protocol overhead.
    var interfaces = [
        { id: 'gige',     name: 'GigE Vision (1 GbE)',      mbps: 115 },
        { id: 'gige2',    name: '2.5GigE',                  mbps: 290 },
        { id: 'gige5',    name: '5GigE',                    mbps: 580 },
        { id: 'gige10',   name: '10GigE',                   mbps: 1150 },
        { id: 'usb3',     name: 'USB3 Vision (5 Gb/s)',     mbps: 380 },
        { id: 'clbase',   name: 'Camera Link Base',         mbps: 255 },
        { id: 'clfull',   name: 'Camera Link Full',         mbps: 680 },
        { id: 'cxp6',     name: 'CoaXPress CXP-6 ×1',       mbps: 600 },
        { id: 'cxp12',    name: 'CoaXPress CXP-12 ×1',      mbps: 1200 },
        { id: 'cxp12x4',  name: 'CoaXPress CXP-12 ×4',      mbps: 4800 }
    ];

    // Bytes per pixel on the wire for common GenICam pixel formats.
    var pixelFormats = [
        { id: 'mono8',  name: 'Mono8 / Bayer8',      bpp: 1 },
        { id: 'mono10', name: 'Mono10p / Bayer10p',  bpp: 1.25 },
        { id: 'mono12', name: 'Mono12p / Bayer12p',  bpp: 1.5 },
        { id: 'rgb8',   name: 'RGB8 (debayered)',    bpp: 3 }
    ];

    // Lens formats by image-circle diameter (mm), smallest first.
    var lensFormats = [
        { name: '1/2″',  circle: 8.0,  mount: 'C-mount or CS-mount' },
        { name: '1/1.8″', circle: 9.0, mount: 'C-mount' },
        { name: '2/3″',  circle: 11.0, mount: 'C-mount' },
        { name: '1″',    circle: 16.0, mount: 'C-mount' },
        { name: '1.1″',  circle: 17.6, mount: 'C-mount' },
        { name: '1.2″',  circle: 19.3, mount: 'C-mount (1.2″-rated lenses only)' },
        { name: '4/3″',  circle: 21.6, mount: 'TFL-II (M35) or M42' },
        { name: 'APS-C', circle: 28.4, mount: 'M42 or TFL-II' },
        { name: '35 mm full frame', circle: 43.3, mount: 'F-mount, M58, or M72' },
        { name: 'Large format', circle: 60, mount: 'M72 or larger, often with a custom lens' }
    ];

    var focalLengths = [4, 5, 6, 8, 12, 16, 25, 35, 50, 75, 100];

    var lighting = {
        measure: {
            label: 'Dimensional gauging (edges, holes, profiles)',
            light: 'Backlight for a sharp silhouette. Use a telecentric lens with a collimated or telecentric backlight when part height varies or accuracy matters.',
            color: 'Monochrome camera. Blue or green light gives the finest diffraction-limited edges; red tolerates dust and surface tint.'
        },
        flat: {
            label: 'Defects on flat, reflective surfaces (glass, wafers, polished metal)',
            light: 'Coaxial (on-axis) diffuse light for bright-field contrast; add a low-angle dark-field ring to make scratches, chips, and particles glow.',
            color: 'Monochrome camera. Shorter wavelengths scatter more strongly from small particles and scratches.'
        },
        curved: {
            label: 'Shiny or curved parts (cans, balls, molded parts)',
            light: 'Dome (cloudy-day) light so every surface normal sees a uniform bright field without hot spots.',
            color: 'Monochrome unless color defects matter.'
        },
        print: {
            label: 'Print, codes, and OCR on matte surfaces',
            light: 'Bar or ring light at 30–45°, with crossed polarizers if glare remains.',
            color: 'Monochrome. Pick an LED color complementary to the ink or label color to maximize contrast.'
        },
        presence: {
            label: 'Presence, assembly, and orientation checks',
            light: 'Diffuse ring or bar light, enclosed or shrouded to reject ambient light.',
            color: 'Color camera only if the decision depends on color; otherwise monochrome for sharper images.'
        },
        transparent: {
            label: 'Transparent parts (glass, film, bottles)',
            light: 'Backlight with a dark-field or patterned background; a fringe or line pattern (deflectometry) reveals waviness and distortion.',
            color: 'Monochrome. UV or NIR can separate coatings and contaminants.'
        },
        color: {
            label: 'Color sorting and color inspection',
            light: 'Diffuse white light (dome or flat dome) with stable color temperature; warm up and monitor the source.',
            color: 'Color camera with white balance against a reference; use a spectrophotometer (CIELAB) for absolute color.'
        }
    };

    function sensorById(id) { for (var i = 0; i < sensors.length; i++) if (sensors[i].id === id) return sensors[i]; return null; }
    function formatLabel(s) { return s.format || ('Ø ' + s.diag.toFixed(1) + ' mm'); }
    function lensFormatFor(diag) {
        for (var i = 0; i < lensFormats.length; i++) if (lensFormats[i].circle >= diag - 0.15) return lensFormats[i];   // 2/3″ lenses cover an 11.05 mm diagonal
        return lensFormats[lensFormats.length - 1];
    }
    // <select> options grouped by maker
    function sensorOptionsHTML(selectedId) {
        var makers = [];
        sensors.forEach(function (s) { if (makers.indexOf(s.maker) < 0) makers.push(s.maker); });
        return makers.map(function (m) {
            return '<optgroup label="' + m + '">' + sensors.filter(function (s) { return s.maker === m; }).map(function (s) {
                return '<option value="' + s.id + '"' + (s.id === selectedId ? ' selected' : '') + '>' +
                    s.name + ' · ' + formatLabel(s) + ' · ' + s.nx + ' × ' + s.ny + ' · ' + s.pitch + ' µm' +
                    (s.shutter === 'rolling' ? ' · rolling' : '') + '</option>';
            }).join('') + '</optgroup>';
        }).join('');
    }

    window.VisionData = {
        sensors: sensors, interfaces: interfaces, pixelFormats: pixelFormats, lensFormats: lensFormats,
        focalLengths: focalLengths, lighting: lighting,
        sensorById: sensorById, formatLabel: formatLabel, lensFormatFor: lensFormatFor, sensorOptionsHTML: sensorOptionsHTML
    };
})();
