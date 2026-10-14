/* ==========================================================================
   cdfoley.com — vision-data.js
   Shared machine vision reference data for the lens calculator and the
   vision system configurator: area-scan sensors, camera interfaces, lens
   formats and mounts, standard focal lengths, and lighting guidance.

   Sensors: 392 area-scan sensors from ten makers, each checked against the
   maker's own datasheet, flyer, product page, or press release (or a maker
   document hosted by a distributor or archived by the Wayback Machine), with
   one source link per row. Fifteen rows are of medium confidence: part of
   their data comes from a distributor's or camera maker's page (e.g. ICX655,
   IMX477, IMX708, OV5647), or the maker does not say whether the part comes
   in mono or color (SmartSens SC0xx/SC1xx/SC2xx/SC3xx/SC5xx HGS rows: listed
   as both; Fairchild HWK4123: listed as mono). Line-scan, TDI, SWIR, time-of-flight, and SPAD
   parts are left out, and so are two interlaced analog-video CCDs with
   non-square pixels (Sony ICX428 and ICX429), because both calculators
   assume square pixels.

   Pixel array convention (the "basis" column): the maker's recommended
   recording array where the maker states one ('rec'; what most cameras
   output by default; Sony gives one for most of its parts, SmartSens gives
   the full-resolution output), otherwise the effective ('eff') or active
   ('act') array. Camera makers may crop further, so confirm against the
   camera datasheet.

   Other columns: shutter GS global, RS rolling, IL interline-transfer CCD
   (every pixel exposed at once, like a global shutter; "frame readout" CCDs
   read two fields one after the other), FF full-frame CCD (no electronic
   shutter: needs a mechanical shutter or a strobe in the dark). Format: the
   maker's optical format, null where the maker names none or gives only a
   diagonal (shown as the computed diagonal). Tech: FSI, BSI, or stacked BSI
   (SBSI) CMOS, CMOS with the structure not stated, or CCD. Color: M mono
   only, C color only, MC both. Max fps: the maker's full-resolution figure,
   with its bit depth where stated. Year: release year, or the earliest
   dated maker document or announcement (the part may be older). Status: A
   active, EOL discontinued (only where the maker or an authorized
   distributor says so), ? not stated either way.
   Sources, checked 2026-10-14; every link loaded (HTTP 200) that day.
   ========================================================================== */
(function () {
    'use strict';

    // Source links: '@key/rest' expands to URLS[key] + 'rest'.
    var URLS = {
        sony: 'https://www.sony-semicon.com/files/62/',
        onsemi: 'https://www.onsemi.com/',
        archive: 'https://web.archive.org/web/',
        gpixel: 'https://www.gpixel.com/en/',
        teledyne: 'https://www.teledynevisionsolutions.com/products/',
        ams: 'https://ams-osram.com/products/sensor-solutions/cmos-image-sensors/',
        smartsens: 'https://www.smartsenstech.com/en/',
        ovt: 'https://www.ovt.com/',
        stvision: 'https://www.1stvision.com/cameras/sensor_specs/',
        canon: 'https://canon-cmos-sensors.com/'
    };

    // [maker, family, rows]; each row: id, name, nx, ny, pitch (µm), shutter, format, tech, color, max fps,
    // its bit depth, year, status, array basis, source[, extra search words]. The header explains the codes.
    var G = [
        ['Sony', 'Pregius S', [
            ['imx900', 'IMX900', 2048, 1536, 2.25, 'GS', '1/3.1″', 'SBSI', 'MC', 125, 8, 2023, 'A', 'rec', '@sony/flyer_industry/IMX900-AMR_Flyer.pdf'],
            ['imx537', 'IMX537', 2448, 2048, 2.74, 'GS', '1/1.8″', 'SBSI', 'MC', 259, 10, 2020, 'A', 'rec', '@sony/flyer_industry/IMX537-AAMJ_Flyer.pdf'],
            ['imx547', 'IMX547', 2448, 2048, 2.74, 'GS', '1/1.8″', 'SBSI', 'MC', 122, 8, 2020, 'A', 'rec', '@sony/flyer_industry/IMX547-AAMJ_Flyer.pdf'],
            ['imx548', 'IMX548', 2448, 2048, 2.74, 'GS', '1/1.8″', 'SBSI', 'MC', 114, 8, 2020, 'A', 'rec', '@sony/flyer_industry/IMX548-AAMJ_Flyer.pdf'],
            ['imx567', 'IMX567', 2448, 2048, 2.74, 'GS', '1/1.8″', 'SBSI', 'MC', 96, 8, 2020, 'A', 'rec', '@sony/flyer_industry/IMX567-AAMJ_Flyer.pdf'],
            ['imx568', 'IMX568', 2448, 2048, 2.74, 'GS', '1/1.8″', 'SBSI', 'MC', 96, 8, 2020, 'A', 'rec', '@sony/flyer_industry/IMX568-AAMJ_Flyer.pdf'],
            ['imx487', 'IMX487', 2840, 2840, 2.74, 'GS', '2/3″', 'SBSI', 'M', 194, 8, 2021, 'A', 'rec', '@sony/flyer_industry/IMX487-AAMJ_AAMJ1-RG_Flyer.pdf'],
            ['imx536', 'IMX536', 2840, 2840, 2.74, 'GS', '2/3″', 'SBSI', 'MC', 194, 8, 2020, 'A', 'rec', '@sony/flyer_industry/IMX536-AAMJ_Flyer.pdf'],
            ['imx546', 'IMX546', 2840, 2840, 2.74, 'GS', '2/3″', 'SBSI', 'MC', 91, 8, 2020, 'A', 'rec', '@sony/flyer_industry/IMX546-AAMJ_Flyer.pdf'],
            ['imx566', 'IMX566', 2840, 2840, 2.74, 'GS', '2/3″', 'SBSI', 'MC', 62, 8, 2020, 'A', 'rec', '@sony/flyer_industry/IMX566-AAMJ_Flyer.pdf'],
            ['imx535', 'IMX535', 4096, 3000, 2.74, 'GS', '1/1.1″', 'SBSI', 'MC', 184, 8, 2024, 'A', 'rec', '@sony/flyer_industry/IMX535-AAMJ_AAMJ1-RG_Flyer.pdf'],
            ['imx545', 'IMX545', 4096, 3000, 2.74, 'GS', '1/1.1″', 'SBSI', 'MC', 68, 8, 2020, 'A', 'rec', '@sony/flyer_industry/IMX545-AAMJ_Flyer.pdf'],
            ['imx565', 'IMX565', 4096, 3000, 2.74, 'GS', '1/1.1″', 'SBSI', 'MC', 42, 8, 2020, 'A', 'rec', '@sony/flyer_industry/IMX565-AAMJ_Flyer.pdf'],
            ['imx926', 'IMX926', 4120, 3000, 2.74, 'GS', '1/1.1″', 'SBSI', 'MC', 660, 8, 2024, 'A', 'rec', '@sony/flyer_industry/IMX926-AMJ_Flyer.pdf'],
            ['imx936', 'IMX936', 4120, 3000, 2.74, 'GS', '1/1.1″', 'SBSI', 'MC', 339, 8, 2024, 'A', 'rec', '@sony/flyer_industry/IMX936-AMJ_Flyer.pdf'],
            ['imx532', 'IMX532', 5320, 3032, 2.74, 'GS', '1.1″', 'SBSI', 'MC', 159, 8, 2020, 'A', 'rec', '@sony/flyer_industry/IMX532-AAMJ_Flyer.pdf'],
            ['imx542', 'IMX542', 5320, 3032, 2.74, 'GS', '1.1″', 'SBSI', 'MC', 52, 8, 2020, 'A', 'rec', '@sony/flyer_industry/IMX542-AAMJ_Flyer.pdf'],
            ['imx531', 'IMX531', 4504, 4504, 2.74, 'GS', '1.1″', 'SBSI', 'MC', 109, 8, 2020, 'A', 'rec', '@sony/flyer_industry/IMX531-AAMJ_Flyer.pdf'],
            ['imx541', 'IMX541', 4504, 4504, 2.74, 'GS', '1.1″', 'SBSI', 'MC', 42, 8, 2020, 'A', 'rec', '@sony/flyer_industry/IMX541-AAMJ_Flyer.pdf'],
            ['imx902', 'IMX902', 6040, 2040, 2.74, 'GS', '1.1″', 'SBSI', 'MC', 134, 10, 2024, 'A', 'rec', '@sony/flyer_industry/IMX902-AMR_Flyer.pdf'],
            ['imx530', 'IMX530', 5320, 4600, 2.74, 'GS', '1.2″', 'SBSI', 'MC', 106, 8, 2020, 'A', 'rec', '@sony/flyer_industry/IMX530-AAMJ_Flyer.pdf'],
            ['imx540', 'IMX540', 5320, 4600, 2.74, 'GS', '1.2″', 'SBSI', 'MC', 35, 8, 2020, 'A', 'rec', '@sony/flyer_industry/IMX540-AAMJ_Flyer.pdf'],
            ['imx925', 'IMX925', 5320, 4600, 2.74, 'GS', '1.2″', 'SBSI', 'MC', 442, 8, 2024, 'A', 'rec', '@sony/flyer_industry/IMX925-AMJ_AMJ1-RG_Flyer.pdf'],
            ['imx935', 'IMX935', 5320, 4600, 2.74, 'GS', '1.2″', 'SBSI', 'MC', 225, 8, 2024, 'A', 'rec', '@sony/flyer_industry/IMX935-AMJ_Flyer.pdf'],
            ['imx901', 'IMX901', 8008, 2040, 2.74, 'GS', '1.4″', 'SBSI', 'MC', 134, 10, 2024, 'A', 'rec', '@sony/flyer_industry/IMX901-AMR_Flyer.pdf'],
            ['imx929', 'IMX929', 8192, 6144, 2.74, 'GS', '1.8″', 'SBSI', 'MC', 225, 8, 2026, 'A', 'rec', '@sony/flyer_industry/IMX929-AMB_Flyer.pdf'],
            ['imx949', 'IMX949', 4096, 3072, 5.48, 'GS', '1.8″', 'SBSI', 'MC', 811, 8, 2026, 'A', 'rec', '@sony/flyer_industry/IMX949-AMB_Flyer.pdf'],
            ['imx939', 'IMX939', 8224, 6176, 2.74, 'GS', '1.8″', 'SBSI', 'MC', 115, 8, null, 'A', 'eff', '@sony/csv/industory_data_en.csv'],
            ['imx928', 'IMX928', 8248, 8248, 2.74, 'GS', '2″', 'SBSI', 'MC', 138, 8, 2025, 'A', 'rec', '@sony/flyer_industry/IMX928-AMB_Flyer.pdf'],
            ['imx938', 'IMX938', 8256, 8256, 2.74, 'GS', '2″', 'SBSI', 'MC', 70, 8, null, 'A', 'eff', '@sony/csv/industory_data_en.csv'],
            ['imx927', 'IMX927', 10240, 10240, 2.74, 'GS', '2.5″', 'SBSI', 'MC', 112, 8, 2025, 'A', 'rec', '@sony/flyer_industry/IMX927-AMB_Flyer.pdf'],
            ['imx947', 'IMX947', 5120, 5120, 5.48, 'GS', '2.5″', 'SBSI', 'MC', 423, 8, 2026, 'A', 'rec', '@sony/flyer_industry/IMX947-AMB_Flyer.pdf'],
            ['imx937', 'IMX937', 10272, 10272, 2.74, 'GS', '2.5″', 'SBSI', 'MC', 56, 8, null, 'A', 'eff', '@sony/csv/industory_data_en.csv']
        ]],
        ['Sony', 'Pregius', [
            ['imx296', 'IMX296', 1440, 1080, 3.45, 'GS', '1/2.9″', 'FSI', 'MC', 60, 10, 2017, 'A', 'rec', '@sony/flyer_industry/IMX296LLR_Flyer.pdf'],
            ['imx297', 'IMX297', 720, 540, 6.9, 'GS', '1/2.9″', 'FSI', 'MC', 120, 10, 2017, 'A', 'rec', '@sony/flyer_industry/IMX297LLR_Flyer.pdf'],
            ['imx273', 'IMX273', 1456, 1088, 3.45, 'GS', '1/2.9″', 'FSI', 'MC', 276, 8, 2017, 'A', 'rec', '@sony/flyer_industry/IMX273_287_296_297_Flyer.pdf'],
            ['imx287', 'IMX287', 728, 544, 6.9, 'GS', '1/2.9″', 'FSI', 'MC', 523.5, 8, 2017, 'A', 'rec', '@sony/flyer_industry/IMX273_287_296_297_Flyer.pdf'],
            ['imx392', 'IMX392', 1920, 1200, 3.45, 'GS', '1/2.3″', 'FSI', 'MC', 201, 8, 2018, 'A', 'rec', '@sony/flyer_industry/IMX392LLR_Flyer.pdf'],
            ['imx252', 'IMX252', 2048, 1536, 3.45, 'GS', '1/1.8″', 'FSI', 'MC', 216.2, 8, 2015, 'A', 'rec', '@sony/flyer_industry/IMX250_252_Flyer.pdf'],
            ['imx265', 'IMX265', 2048, 1536, 3.45, 'GS', '1/1.8″', 'FSI', 'MC', 55, 12, 2016, 'A', 'rec', '@sony/flyer_industry/IMX264_265_Flyer.pdf'],
            ['imx422', 'IMX422', 1624, 1240, 4.5, 'GS', '1/1.7″', 'FSI', 'MC', 477, 8, 2017, 'A', 'rec', '@sony/flyer_industry/IMX422LLJ_Flyer.pdf'],
            ['imx426', 'IMX426', 812, 620, 9, 'GS', '1/1.7″', 'FSI', 'MC', 1594, 8, 2018, 'A', 'rec', '@sony/flyer_industry/IMX426LLJ_Flyer.pdf'],
            ['imx430', 'IMX430', 1624, 1240, 4.5, 'GS', '1/1.7″', 'FSI', 'MC', 132, 12, 2017, 'A', 'rec', '@sony/flyer_industry/IMX430LLJ_Flyer.pdf'],
            ['imx433', 'IMX433', 812, 620, 9, 'GS', '1/1.7″', 'FSI', 'MC', 243, 12, 2018, 'A', 'rec', '@sony/flyer_industry/IMX433LLJ_Flyer.pdf'],
            ['imx421', 'IMX421', 1936, 1464, 4.5, 'GS', '2/3″', 'FSI', 'MC', 409, 8, 2017, 'A', 'rec', '@sony/flyer_industry/IMX421LLJ_Flyer.pdf'],
            ['imx429', 'IMX429', 1936, 1464, 4.5, 'GS', '2/3″', 'FSI', 'MC', 96, 12, 2017, 'A', 'rec', '@sony/flyer_industry/IMX429LLJ_Flyer.pdf'],
            ['imx437', 'IMX437', 1936, 1464, 4.5, 'GS', '2/3″', 'FSI', 'C', 231, 12, 2017, 'A', 'rec', '@sony/flyer_industry/IMX437LQJ_Flyer.pdf'],
            ['imx250', 'IMX250', 2448, 2048, 3.45, 'GS', '2/3″', 'FSI', 'MC', 163.4, 8, 2015, 'A', 'rec', '@sony/flyer_industry/IMX250_252_Flyer.pdf'],
            ['imx264', 'IMX264', 2448, 2048, 3.45, 'GS', '2/3″', 'FSI', 'MC', 35, 12, 2016, 'A', 'rec', '@sony/flyer_industry/IMX264_265_Flyer.pdf'],
            ['imx174', 'IMX174', 1920, 1200, 5.86, 'GS', '1/1.2″', 'FSI', 'MC', 164.5, 10, 2013, 'A', 'rec', '@sony/flyer_industry/IMX174LQJ_LLJ_Flyer.pdf'],
            ['imx249', 'IMX249', 1920, 1200, 5.86, 'GS', '1/1.2″', 'FSI', 'MC', 30, 12, 2015, 'A', 'rec', '@sony/flyer_industry/IMX249LQJ_LLJ_Flyer.pdf'],
            ['imx302', 'IMX302', 1920, 1200, 5.86, 'GS', '1/1.2″', 'FSI', 'C', 64, 12, null, 'A', 'rec', '@sony/flyer_industry/IMX302LQJ_Flyer.pdf'],
            ['imx267', 'IMX267', 4096, 2160, 3.45, 'GS', '1″', 'FSI', 'MC', 32, 12, 2018, 'A', 'rec', '@sony/flyer_industry/IMX267LLR_Flyer.pdf'],
            ['imx255', 'IMX255', 4112, 2176, 3.45, 'GS', '1″', 'FSI', 'MC', 93.7, 8, 2016, 'A', 'eff', '@sony/flyer_industry/IMX253_255LLR_LQR_Flyer.pdf'],
            ['imx420', 'IMX420', 3208, 2200, 4.5, 'GS', '1.1″', 'FSI', 'MC', 207, 8, 2017, 'A', 'rec', '@sony/flyer_industry/IMX420LLJ_Flyer.pdf'],
            ['imx425', 'IMX425', 1604, 1100, 9, 'GS', '1.1″', 'FSI', 'MC', 662, 8, 2018, 'A', 'rec', '@sony/flyer_industry/IMX425LLJ_Flyer.pdf'],
            ['imx428', 'IMX428', 3208, 2200, 4.5, 'GS', '1.1″', 'FSI', 'MC', 39, 12, 2017, 'A', 'rec', '@sony/flyer_industry/IMX428LLJ_Flyer.pdf'],
            ['imx432', 'IMX432', 1604, 1100, 9, 'GS', '1.1″', 'FSI', 'MC', 75, 12, 2018, 'A', 'rec', '@sony/flyer_industry/IMX432LLJ_Flyer.pdf'],
            ['imx304', 'IMX304', 4096, 3000, 3.45, 'GS', '1.1″', 'FSI', 'MC', 23, 12, 2018, 'A', 'rec', '@sony/flyer_industry/IMX304LLR_Flyer.pdf'],
            ['imx253', 'IMX253', 4112, 3008, 3.45, 'GS', '1.1″', 'FSI', 'MC', 68.3, 8, 2016, 'A', 'eff', '@sony/flyer_industry/IMX253_255LLR_LQR_Flyer.pdf'],
            ['imx367', 'IMX367', 4416, 4428, 3.45, 'GS', '4/3″', 'FSI', 'MC', 43, 8, 2018, 'A', 'rec', '@sony/flyer_industry/IMX367LLA_Flyer.pdf'],
            ['imx387', 'IMX387', 5456, 3076, 3.45, 'GS', '4/3″', 'FSI', 'MC', 61, 8, 2018, 'A', 'rec', '@sony/flyer_industry/IMX387LLA_Flyer.pdf'],
            ['imx342', 'IMX342', 6464, 4852, 3.45, 'GS', 'APS-C', 'FSI', 'MC', 35, 8, 2018, 'A', 'rec', '@sony/flyer_industry/IMX342LLA_Flyer.pdf'],
            ['imx661', 'IMX661', 13472, 9568, 3.45, 'GS', '3.6″', 'FSI', 'MC', 21, 10, 2021, 'A', 'eff', '@sony/flyer_industry/IMX661-AAMR_Flyer.pdf']
        ]],
        ['Sony', 'Polarsens', [
            ['imx250-pol', 'IMX250MZR/MYR', 2448, 2048, 3.45, 'GS', '2/3″', 'FSI', 'MC', 163.4, 8, 2018, 'A', 'rec', '@sony/flyer_industry/IMX250_264_253MZR_MYR_Flyer_en.pdf', 'IMX250MYR'],
            ['imx264-pol', 'IMX264MZR/MYR', 2448, 2048, 3.45, 'GS', '2/3″', 'FSI', 'MC', 35, 12, 2018, 'A', 'rec', '@sony/flyer_industry/IMX250_264_253MZR_MYR_Flyer_en.pdf', 'IMX264MYR'],
            ['imx253-pol', 'IMX253MZR/MYR', 4112, 3008, 3.45, 'GS', '1.1″', 'FSI', 'MC', 68.3, 8, 2018, 'A', 'eff', '@sony/flyer_industry/IMX250_264_253MZR_MYR_Flyer_en.pdf', 'IMX253MYR']
        ]],
        ['Sony', 'STARVIS 3', [
            ['imx908', 'IMX908', 3840, 2160, 1.45, 'RS', '1/2.8″', 'BSI', 'C', 90, 10, 2026, 'A', 'rec', '@sony/flyer_security/IMX908-AQH5_Flyer.pdf']
        ]],
        ['Sony', 'STARVIS 2', [
            ['imx662', 'IMX662', 1920, 1080, 2.9, 'RS', '1/2.8″', 'BSI', 'C', 90, 10, 2021, '?', 'rec', '@sony/flyer_security/IMX662-AAQR_Flyer.pdf'],
            ['imx832', 'IMX832', 1920, 1080, 2.9, 'RS', '1/2.8″', 'BSI', 'C', 90, 10, 2022, 'A', 'rec', '@sony/flyer_security/IMX832-AQR_AQR1_Flyer.pdf'],
            ['imx675', 'IMX675', 2592, 1944, 2, 'RS', '1/2.8″', 'BSI', 'MC', 80, 10, 2023, 'A', 'rec', '@sony/flyer_security/IMX675-AAMR_Flyer.pdf'],
            ['imx678', 'IMX678', 3840, 2160, 2, 'RS', '1/1.8″', 'BSI', 'MC', 72, 10, 2022, 'A', 'rec', '@sony/flyer_security/IMX678-AAMR1_Flyer.pdf'],
            ['imx838', 'IMX838', 3840, 2160, 2, 'RS', '1/1.8″', 'BSI', 'C', 72, 10, 2024, 'A', 'rec', '@sony/flyer_security/IMX838-AQR1_Flyer.pdf'],
            ['imx664', 'IMX664', 2688, 1520, 2.9, 'RS', '1/1.8″', 'BSI', 'MC', 120, 10, 2022, 'A', 'rec', '@sony/flyer_security/IMX664-AAMR1_Flyer.pdf'],
            ['imx785', 'IMX785', 2592, 1944, 2.9, 'RS', '1/1.7″', 'BSI', 'MC', 90, 10, 2026, 'A', 'rec', '@sony/flyer_security/IMX785-AMR1_Flyer.pdf'],
            ['imx676', 'IMX676', 3536, 3536, 2, 'RS', '1/1.6″', 'BSI', 'MC', 60, 10, 2023, 'A', 'rec', '@sony/flyer_security/IMX676-AACR1_Flyer.pdf'],
            ['imx585', 'IMX585', 3840, 2160, 2.9, 'RS', '1/1.2″', 'BSI', 'MC', 90, 10, 2021, 'A', 'rec', '@sony/flyer_security/IMX585-AAMJ1_Flyer.pdf'],
            ['imx835', 'IMX835', 3840, 2160, 2.9, 'RS', '1/1.2″', 'BSI', 'C', 90, 10, 2024, 'A', 'rec', '@sony/flyer_security/IMX835-AQJ1_Flyer.pdf']
        ]],
        ['Sony', 'STARVIS', [
            ['imx290', 'IMX290', 1920, 1080, 2.9, 'RS', '1/2.8″', 'BSI', 'MC', 120, 10, 2015, '?', 'rec', '@archive/20150221073822/http://www.sony.net:80/Products/SC-HP/new_pro/february_2015/imx290_291_e.html'],
            ['imx307', 'IMX307', 1920, 1080, 2.9, 'RS', '1/2.8″', 'BSI', 'C', 60, null, 2017, '?', 'rec', '@archive/2019/https://www.sony-semicon.co.jp/products_en/IS/sensor0/img/product/cmos/IMX307LQD_LQR_Flyer02.pdf'],
            ['imx327', 'IMX327', 1920, 1080, 2.9, 'RS', '1/2.8″', 'BSI', 'C', 60, null, 2017, '?', 'rec', '@sony/flyer_security/IMX327LQR_LQR1_Flyer.pdf'],
            ['imx415', 'IMX415', 3840, 2160, 1.45, 'RS', '1/2.8″', 'BSI', 'C', 90.9, 10, 2019, 'A', 'rec', '@sony/flyer_security/IMX415-AAQR_Flyer.pdf'],
            ['imx462', 'IMX462', 1920, 1080, 2.9, 'RS', '1/2.8″', 'BSI', 'C', 120, null, 2019, '?', 'rec', '@sony/flyer_security/IMX462LQR_Flyer.pdf'],
            ['imx515', 'IMX515', 3840, 2160, 1.45, 'RS', '1/2.8″', 'BSI', 'C', 61.6, 10, 2021, 'A', 'rec', '@sony/flyer_security/IMX515-AAQN_Flyer.pdf'],
            ['imx715', 'IMX715', 3840, 2160, 1.45, 'RS', '1/2.8″', 'BSI', 'C', 90.9, 10, 2021, 'A', 'rec', '@sony/flyer_security/IMX715-AAQR1_Flyer.pdf'],
            ['imx778', 'IMX778', 3840, 2160, 1.45, 'RS', '1/2.8″', 'BSI', 'C', 90, 10, 2024, 'A', 'rec', '@sony/flyer_security/IMX778-AQR1_Flyer.pdf'],
            ['imx779', 'IMX779', 3840, 2160, 1.45, 'RS', '1/2.8″', 'BSI', 'C', 90, 10, 2024, 'A', 'rec', '@sony/flyer_security/IMX779-AQR_AQN_Flyer.pdf'],
            ['imx123', 'IMX123', 2065, 1553, 2.5, 'RS', '1/2.8″', 'BSI', 'C', 120, 12, 2014, '?', 'eff', '@archive/20140802052533/http://www.sony.net:80/Products/SC-HP/new_pro/june_2014/imx123_e.html'],
            ['imx291', 'IMX291', 1945, 1097, 2.9, 'RS', '1/2.8″', 'BSI', 'C', 120, 10, 2015, '?', 'eff', '@archive/20150221073822/http://www.sony.net:80/Products/SC-HP/new_pro/february_2015/imx290_291_e.html'],
            ['imx335', 'IMX335', 2592, 1944, 2, 'RS', '1/2.8″', 'BSI', 'MC', 60, 10, 2018, 'A', 'rec', '@sony/flyer_industry/IMX335LLN_Flyer.pdf'],
            ['imx412', 'IMX412', 4056, 3040, 1.55, 'RS', '1/2.3″', 'SBSI', 'C', 60, null, 2018, 'A', 'rec', '@sony/flyer_security/IMX412-AACK_Flyer.pdf'],
            ['imx334', 'IMX334', 3840, 2160, 2, 'RS', '1/1.8″', 'BSI', 'MC', 60, 12, 2017, '?', 'rec', '@archive/2019/https://www.sony-semicon.co.jp/products_en/IS/sensor0/img/product/cmos/IMX334LLR_LQR_Flyer.pdf'],
            ['imx178', 'IMX178', 3072, 2048, 2.4, 'RS', '1/1.8″', 'BSI', 'MC', 60, null, 2013, 'A', 'rec', '@sony/flyer_security/IMX178LQJ_Flyer.pdf'],
            ['imx347', 'IMX347', 2688, 1520, 2.9, 'RS', '1/1.8″', 'BSI', 'C', 90, null, 2019, 'A', 'rec', '@sony/flyer_security/IMX347LQR_Flyer.pdf'],
            ['imx464', 'IMX464', 2688, 1520, 2.9, 'RS', '1/1.8″', 'BSI', 'C', 90, null, 2022, 'A', 'rec', '@sony/flyer_security/IMX464LQR_LQR1_Flyer.pdf'],
            ['imx226', 'IMX226', 4000, 3000, 1.85, 'RS', '1/1.7″', 'BSI', 'MC', 40, 10, 2014, 'A', 'rec', '@sony/flyer_industry/IMX290_178_226_Flyer.pdf'],
            ['imx485', 'IMX485', 3840, 2160, 2.9, 'RS', '1/1.2″', 'BSI', 'C', 90, 10, 2019, '?', 'rec', '@sony/flyer_security/IMX485LQJ_Flyer.pdf'],
            ['imx533', 'IMX533', 3011, 3011, 3.76, 'RS', '1″', 'BSI', 'MC', 75, 10, 2019, 'A', 'eff', '@sony/flyer_industry/IMX533CLK_Flyer.pdf'],
            ['imx294', 'IMX294', 3704, 2778, 4.63, 'RS', '4/3″', 'BSI', 'C', 60, null, 2017, 'A', 'rec', '@sony/flyer_security/IMX294CJK_Flyer.pdf'],
            ['imx571', 'IMX571', 6252, 4176, 3.76, 'RS', '1.8″', 'BSI', 'MC', 48, 11, 2019, 'A', 'eff', '@sony/flyer_industry/IMX571BLR-J_Flyer.pdf'],
            ['imx455', 'IMX455', 9576, 6388, 3.76, 'RS', '2.7″', 'BSI', 'MC', 21, 10, 2019, 'A', 'eff', '@sony/flyer_industry/IMX455ALK-K_Flyer.pdf']
        ]],
        ['Sony', 'STARVIS (Quad Bayer)', [
            ['imx482', 'IMX482', 1920, 1080, 5.8, 'RS', '1/1.2″', 'BSI', 'C', 90, 10, 2023, '?', 'rec', '@sony/flyer_security/IMX482LQJ_Flyer.pdf']
        ]],
        ['Sony', 'Exmor R', [
            ['imx219', 'IMX219', 3280, 2464, 1.12, 'RS', '1/4.0″', 'BSI', 'C', 30, null, 2014, '?', 'act', '@archive/20140823185819/http://www.sony.net:80/Products/SC-HP/new_pro/april_2014/imx219_e.html'],
            ['imx377', 'IMX377', 4000, 3000, 1.55, 'RS', '1/2.3″', 'BSI', 'C', 39.96, 10, null, '?', 'rec', '@archive/2019/https://www.sony-semicon.co.jp/products_en/IS/sensor2/img/products/IMX377CQT_Flyer.pdf'],
            ['imx410', 'IMX410', 6072, 4056, 5.94, 'RS', '2.7″', 'BSI', 'C', 40.58, 12, 2018, '?', 'eff', '@archive/2019/https://www.sony-semicon.co.jp/products_en/IS/sensor2/img/products/IMX410CQK_Flyer.pdf']
        ]],
        ['Sony', 'Exmor', [
            ['imx224', 'IMX224', 1305, 977, 3.75, 'RS', '1/3″', 'FSI', 'C', 120, 10, 2014, '?', 'eff', '@archive/20141021205925/http://www.sony.net:80/Products/SC-HP/new_pro/october_2014/imx224_225_e.html'],
            ['imx225', 'IMX225', 1305, 977, 3.75, 'RS', '1/3″', 'FSI', 'C', 120, 10, 2014, '?', 'eff', '@archive/20141021205925/http://www.sony.net:80/Products/SC-HP/new_pro/october_2014/imx224_225_e.html'],
            ['imx136', 'IMX136', 1944, 1224, 2.8, 'RS', '1/2.8″', 'FSI', 'MC', 108, 10, 2012, '?', 'eff', '@archive/20131101172124/http://www.sony.net:80/Products/SC-HP/cx_news/vol68/pdf/imx136lqj_llj.pdf'],
            ['imx236', 'IMX236', 1944, 1224, 2.8, 'RS', '1/2.8″', 'FSI', 'C', 108, 10, 2013, '?', 'eff', '@archive/20131017200033/http://www.sony.net:80/Products/SC-HP/new_pro/september_2013/imx222_236_238lqj_e.html'],
            ['imx122', 'IMX122', 1984, 1225, 2.8, 'RS', '1/2.8″', 'FSI', 'C', 40, 10, 2011, '?', 'eff', '@archive/20131126144029/http://www.sony.net:80/Products/SC-HP/cx_news/vol65/pdf/imx122lqj.pdf'],
            ['imx385', 'IMX385', 1920, 1080, 3.75, 'RS', '1/2″', 'FSI', 'C', 120, 10, 2017, '?', 'rec', '@archive/20170425021555/http://www.sony-semicon.co.jp:80/products_en/new_pro/april_2017/imx385lqr_e.html'],
            ['imx185', 'IMX185', 1920, 1200, 3.75, 'RS', '1/1.9″', 'FSI', 'C', 100, 10, 2013, '?', 'rec', '@archive/20131017233647/http://www.sony.net:80/Products/SC-HP/new_pro/september_2013/imx185lqj_e.html']
        ]],
        ['Sony', 'Back-illuminated (no brand)', [
            ['imx183', 'IMX183', 5472, 3648, 2.4, 'RS', '1″', 'BSI', 'MC', 24, 10, 2014, 'A', 'rec', '@sony/flyer_industry/IMX183CLK-J_CQJ-J_Flyer.pdf'],
            ['imx461', 'IMX461', 11664, 8750, 3.76, 'RS', '3.4″', 'BSI', 'MC', 8, 12, 2018, 'A', 'eff', '@sony/flyer_industry/IMX461ALR_Flyer.pdf'],
            ['imx811', 'IMX811', 19240, 12840, 2.81, 'RS', '4.1″', 'BSI', 'MC', 12.4, 12, 2024, 'A', 'eff', '@sony/flyer_industry/IMX811-AAMR_Flyer.pdf'],
            ['imx411', 'IMX411', 14208, 10656, 3.76, 'RS', '4.2″', 'BSI', 'MC', 6, 12, 2018, 'A', 'eff', '@sony/flyer_industry/IMX411ALR_Flyer.pdf']
        ]],
        ['Sony', 'Stacked back-illuminated (no brand)', [
            ['imx708', 'IMX708', 4608, 2592, 1.4, 'RS', null, 'SBSI', 'C', null, null, 2023, '?', 'act', 'https://www.raspberrypi.com/documentation/accessories/camera.html'],
            ['imx477', 'IMX477', 4056, 3040, 1.55, 'RS', '1/2.3″', 'SBSI', 'C', 40, null, 2020, '?', 'act', '@archive/2019/https://www.sony-semicon.co.jp/products_en/IS/sensor2/products/index.html'],
            ['imx06a', 'IMX06A', 8192, 6144, 1.6, 'RS', '1/0.98″', 'SBSI', 'MC', 30, null, 2025, 'A', 'eff', '@sony/flyer_industry/IMX06A-AJ1R-J_Flyer.pdf']
        ]],
        ['Sony', 'CMOS (no brand)', [
            ['imx492', 'IMX492', 8336, 5648, 2.315, 'RS', '1.4″', 'CMOS', 'MC', 24, 10, 2019, 'A', 'eff', '@sony/flyer_industry/IMX492LLJ_Flyer.pdf']
        ]],
        ['Sony', 'EXview HAD CCD II', [
            ['icx692', 'ICX692', 1296, 736, 4.08, 'IL', '1/3″', 'CCD', 'C', 30, null, 2011, 'EOL', 'eff', '@archive/20140809034351/http://www.sony.net:80/Products/SC-HP/cx_news/vol66/pdf/icx692aqa_aka.pdf'],
            ['icx687', 'ICX687', 1940, 1460, 3.69, 'IL', '1/1.8″', 'CCD', 'MC', 25, null, 2012, 'EOL', 'eff', '@archive/20120522152221/http://www.sony.net:80/Products/SC-HP/cx_news/vol67/pdf/icx687ala_aqa.pdf'],
            ['icx674', 'ICX674', 1940, 1460, 4.54, 'IL', '2/3″', 'CCD', 'MC', 50, null, 2010, 'EOL', 'eff', '@archive/20130528222736/http://www.sony.net:80/Products/SC-HP/cx_news/vol62/pdf/icx674alg_aqg.pdf'],
            ['icx825', 'ICX825', 1392, 1040, 6.45, 'IL', '2/3″', 'CCD', 'MC', 45, null, 2014, 'EOL', 'eff', '@archive/20140803073907/http://www.sony.net:80/Products/SC-HP/new_pro/may_2014/icx825_e.html'],
            ['icx834', 'ICX834', 4250, 2838, 3.1, 'IL', '1″', 'CCD', 'MC', 14.5, null, 2014, 'EOL', 'eff', '@archive/20140803073744/http://www.sony.net:80/Products/SC-HP/new_pro/april_2014/icx834_e.html'],
            ['icx814', 'ICX814', 3388, 2712, 3.69, 'IL', '1″', 'CCD', 'MC', 18, null, null, 'EOL', 'eff', '@stvision/ICX814.pdf'],
            ['icx694', 'ICX694', 2758, 2208, 4.54, 'IL', '1″', 'CCD', 'MC', 25, null, 2011, 'EOL', 'eff', '@archive/20130903132850/http://www.sony.net:80/Products/SC-HP/cx_news/vol65/pdf/icx694alg_aqg.pdf']
        ]],
        ['Sony', 'EXview HAD CCD', [
            ['icx618', 'ICX618', 659, 494, 5.6, 'IL', '1/4″', 'CCD', 'MC', 60, null, null, 'EOL', 'eff', 'https://www.pierro-astro.com/images/fichiers/ICX618ALA.pdf'],
            ['icx445', 'ICX445', 1296, 966, 3.75, 'IL', '1/3″', 'CCD', 'MC', 22.5, null, 2007, 'EOL', 'eff', 'https://www.pierro-astro.com/images/fichiers/ICX445ALA.pdf'],
            ['icx285', 'ICX285', 1392, 1040, 6.45, 'IL', '2/3″', 'CCD', 'MC', 15, null, null, 'EOL', 'eff', '@stvision/ICX285.pdf']
        ]],
        ['Sony', 'Super HAD CCD II', [
            ['icx693', 'ICX693', 816, 616, 6, 'IL', '1/3″', 'CCD', 'C', 50, null, null, 'EOL', 'eff', '@archive/20140809034542/http://www.sony.net:80/Products/SC-HP/cx_news/vol69/pdf/icx693aqa_aka.pdf']
        ]],
        ['Sony', 'Super HAD CCD', [
            ['icx274', 'ICX274', 1600, 1200, 4.4, 'IL', '1/1.8″', 'CCD', 'MC', 15, null, null, 'EOL', 'rec', '@stvision/ICX274.pdf'],
            ['icx625', 'ICX625', 2456, 2058, 3.45, 'IL', '2/3″', 'CCD', 'MC', 15, null, null, 'EOL', 'eff', '@stvision/ICX625.pdf']
        ]],
        ['Sony', 'HAD CCD', [
            ['icx098', 'ICX098', 659, 494, 5.6, 'IL', '1/4″', 'CCD', 'MC', 30, null, null, 'EOL', 'eff', 'https://www.pierro-astro.com/images/fichiers/ICX098BL.pdf'],
            ['icx204', 'ICX204', 1034, 779, 4.65, 'IL', '1/3″', 'CCD', 'MC', 20, null, null, 'EOL', 'eff', '@stvision/ICX204.pdf'],
            ['icx424', 'ICX424', 659, 494, 7.4, 'IL', '1/3″', 'CCD', 'M', 60, null, null, 'EOL', 'eff', '@stvision/ICX424.pdf'],
            ['icx205', 'ICX205', 1392, 1040, 4.65, 'IL', '1/2″', 'CCD', 'MC', 7.5, null, null, 'EOL', 'eff', '@stvision/ICX205.pdf'],
            ['icx267', 'ICX267', 1392, 1040, 4.65, 'IL', '1/2″', 'CCD', 'M', 15, null, null, 'EOL', 'eff', '@stvision/ICX267.pdf'],
            ['icx415', 'ICX415', 782, 582, 8.3, 'IL', '1/2″', 'CCD', 'M', 50, null, null, 'EOL', 'eff', '@stvision/ICX415.pdf'],
            ['icx414', 'ICX414', 659, 494, 9.9, 'IL', '1/2″', 'CCD', 'M', 60, null, null, 'EOL', 'eff', '@stvision/ICX414.pdf']
        ]],
        ['Sony', 'CCD', [
            ['icx655', 'ICX655', 2452, 2056, 3.45, 'IL', '2/3″', 'CCD', 'MC', null, null, null, 'EOL', 'act', '@archive/20140803073907/http://www.sony.net:80/Products/SC-HP/new_pro/may_2014/icx825_e.html']
        ]],
        ['Sony', 'Super HAD CCD (frame readout)', [
            ['icx282', 'ICX282', 2588, 1960, 3.4, 'IL', '2/3″', 'CCD', 'C', 3.75, null, null, 'EOL', 'eff', '@stvision/ICX282.pdf']
        ]],
        ['Sony', 'CCD (frame readout)', [
            ['icx413', 'ICX413', 3000, 2000, 7.8, 'IL', 'APS (Type 1.8)', 'CCD', 'C', 3.08, null, 2005, 'EOL', 'rec', '@archive/20050515144031/http://www.sony.net:80/Products/SC-HP/cx_news/vol28/pdf/icx413np.pdf']
        ]],
        ['onsemi', 'XGS', [
            ['xgs2000', 'XGS 2000', 1920, 1200, 3.2, 'GS', '1/2.2″', 'FSI', 'MC', 220, 12, 2020, 'EOL', 'act', '@onsemi/download/public-data-sheet/pdf/xgs5m-pd-d.pdf', 'NOIX4SN2000B-LTI NOIX4SE2000B-LTI'],
            ['xgs3000', 'XGS 3000', 2048, 1536, 3.2, 'GS', '1/2″', 'FSI', 'MC', 175, 12, 2020, '?', 'act', '@onsemi/download/public-data-sheet/pdf/xgs5m-pd-d.pdf', 'NOIX4SF3000B-LTI NOIX4SP3000B-LTI'],
            ['xgs5000', 'XGS 5000', 2592, 2048, 3.2, 'GS', '2/3″', 'FSI', 'MC', 132, 12, 2020, 'A', 'act', '@onsemi/download/public-data-sheet/pdf/xgs5m-pd-d.pdf', 'NOIX4SN5000B-LTI NOIX4SE5000B-LTI NOIX5SN5000B-LTI NOIX5SE50'],
            ['xgs9400', 'XGS 9400', 3072, 3072, 3.2, 'GS', '1/1.2″', 'FSI', 'MC', 90, 12, null, 'A', 'act', '@onsemi/download/public-data-sheet/pdf/xgs12m-pd-d.pdf', 'NOIX1SN9400B-LTI NOIX1SE9400B-LTI NOIX2SN9400B-LTI NOIX2SE94'],
            ['xgs8000', 'XGS 8000', 4096, 2160, 3.2, 'GS', '1/1.1″', 'FSI', 'MC', 128, 12, 2018, 'A', 'act', '@onsemi/download/public-data-sheet/pdf/xgs12m-pd-d.pdf', 'NOIX1SN8000B-LTI NOIX1SE8000B-LTI NOIX2SN8000B-LTI NOIX2SE80'],
            ['xgs12000', 'XGS 12000', 4096, 3072, 3.2, 'GS', '1″', 'FSI', 'MC', 90, 12, 2018, 'A', 'act', '@onsemi/download/public-data-sheet/pdf/xgs12m-pd-d.pdf', 'NOIX1SN012KB-LTI NOIX1SE012KB-LTI NOIX1SF012KB-LTI NOIX3SN01'],
            ['xgs16000', 'XGS 16000', 4000, 4000, 3.2, 'GS', '1.1″', 'FSI', 'MC', 69, 12, 2021, 'A', 'act', '@onsemi/download/public-data-sheet/pdf/xgs16m-pd-d.pdf', 'NOIX1SN016KB-LTI NOIX1SE016KB-LTI NOIX2SN016KB-LTI NOIX2SE01'],
            ['xgs20000', 'XGS 20000', 4500, 4500, 3.2, 'GS', '1.3″', 'FSI', 'MC', 58, 12, 2020, 'EOL', 'act', '@onsemi/download/public-data-sheet/pdf/xgs45m-pd-d.pdf', 'NOIX0SN020KB-GTI NOIX0SE020KB-GTI NOIX1SN020KB-GTI NOIX1SE02'],
            ['xgs30000', 'XGS 30000', 5460, 5460, 3.2, 'GS', 'APS-C', 'FSI', 'MC', 48, 12, 2020, 'A', 'act', '@onsemi/download/public-data-sheet/pdf/xgs45m-pd-d.pdf', 'NOIX0SN030KB-GTI NOIX0SE030KB-GTI NOIX1SN030KB-GTI NOIX1SE03'],
            ['xgs32000', 'XGS 32000', 6580, 4940, 3.2, 'GS', 'APS-C', 'FSI', 'MC', 52, 12, null, 'A', 'act', '@onsemi/download/public-data-sheet/pdf/xgs45m-pd-d.pdf', 'NOIX0SN032KB-GTI NOIX0SE032KB-GTI NOIX1SN032KB-GTI NOIX1SE03'],
            ['xgs45000', 'XGS 45000', 8192, 5460, 3.2, 'GS', 'Super 35 mm', 'FSI', 'MC', 48, 12, 2020, 'A', 'act', '@onsemi/download/public-data-sheet/pdf/xgs45m-pd-d.pdf', 'NOIX0SN045KB-GTI NOIX0SE045KB-GTI NOIX1SN045KB-GTI NOIX1SE04']
        ]],
        ['onsemi', 'PYTHON', [
            ['python300', 'PYTHON 300', 640, 480, 4.8, 'GS', '1/4″', 'FSI', 'MC', 815, 10, 2014, 'A', 'act', '@onsemi/pdf/datasheet/noip1sn1300a-d.pdf', 'NOIP1SN0300A-QTI NOIP1SE0300A-QTI NOIP1FN0300A-QTI'],
            ['python500', 'PYTHON 500', 800, 600, 4.8, 'GS', '1/3.6″', 'FSI', 'MC', 545, 10, 2014, 'A', 'act', '@onsemi/pdf/datasheet/noip1sn1300a-d.pdf', 'NOIP1SN0500A-QTI NOIP1SE0500A-QTI'],
            ['python480', 'PYTHON 480', 808, 608, 4.8, 'GS', '1/3.6″', 'FSI', 'MC', 120, 10, 2016, 'A', 'act', '@onsemi/pdf/datasheet/noip1sn0480a-d.pdf', 'NOIP1SN0480A-STI NOIP1SE0480A-STI NOIP1SF0480A-STI NOIP1SP04'],
            ['python1300', 'PYTHON 1300', 1280, 1024, 4.8, 'GS', '1/2″', 'FSI', 'MC', 210, 10, 2014, 'A', 'act', '@onsemi/pdf/datasheet/noip1sn1300a-d.pdf', 'NOIP1SN1300A-QTI NOIP1SE1300A-QTI NOIP1FN1300A-QTI NOIP2SN13'],
            ['python2000', 'PYTHON 2000', 1920, 1200, 4.8, 'GS', '2/3″', 'FSI', 'MC', 230, 10, 2014, 'A', 'act', '@onsemi/pdf/datasheet/noip1sn5000a-d.pdf', 'NOIP1SN2000A-QTI NOIP1SE2000A-QTI NOIP1FN2000A-QTI NOIP1SN20'],
            ['python5000', 'PYTHON 5000', 2592, 2048, 4.8, 'GS', '1″', 'FSI', 'MC', 100, 10, 2014, 'A', 'act', '@onsemi/pdf/datasheet/noip1sn5000a-d.pdf', 'NOIP1SN5000A-QTI NOIP1SE5000A-QTI NOIP1FN5000A-QTI NOIP1SN50'],
            ['python10k', 'PYTHON 10K', 3840, 2896, 4.5, 'GS', '4/3″', 'FSI', 'MC', 175, 10, 2015, 'EOL', 'act', '@onsemi/products/sensors/image-sensors/python10k', 'NOIP1SN010KA-GDI NOIP1SE010KA-GDI NOIP1FN010KA-GDI'],
            ['python12k', 'PYTHON 12K', 4096, 3072, 4.5, 'GS', '4/3″', 'FSI', 'MC', 160, 10, 2015, 'EOL', 'act', '@onsemi/products/sensors/image-sensors/python12k', 'NOIP1SN012KA-GTI NOIP1SE012KA-GTI NOIP1FN012KA-GTI'],
            ['python16k', 'PYTHON 16K', 4096, 4096, 4.5, 'GS', 'APS-H', 'FSI', 'MC', 112, 10, 2015, 'A', 'act', '@onsemi/pdf/datasheet/noip1sn025ka-d.pdf', 'NOIP1SN016KA-GTI NOIP1SE016KA-GTI NOIP1FN016KA-GTI'],
            ['python25k', 'PYTHON 25K', 5120, 5120, 4.5, 'GS', 'APS-H', 'FSI', 'MC', 80, 10, 2015, 'A', 'act', '@onsemi/pdf/datasheet/noip1sn025ka-d.pdf', 'NOIP1SN025KA-GTI NOIP1SE025KA-GTI NOIP1FN025KA-GTI NOICPSN02']
        ]],
        ['onsemi', 'Hyperlux SG', [
            ['arx383', 'ARX383CS', 640, 480, 2.8, 'GS', '1/8″', 'CMOS', 'M', 120, 10, null, 'A', 'act', '@onsemi/download/public-data-sheet/pdf/arx383cs-pd-d.pdf'],
            ['ar0145', 'AR0145CS', 1280, 800, 2.8, 'GS', '1/4.3″', 'CMOS', 'MC', 120, 10, null, 'A', 'act', '@onsemi/download/public-data-sheet/pdf/ar0145cs-pd-d.pdf'],
            ['ar0235', 'AR0235CS', 1920, 1200, 2.8, 'GS', '1/2.8″', 'CMOS', 'MC', 120, 10, null, 'A', 'act', '@onsemi/download/public-data-sheet/pdf/ar0235cs-pd-d.pdf']
        ]],
        ['onsemi', 'AR', [
            ['ar0144', 'AR0144CS', 1280, 800, 3, 'GS', '1/4″', 'FSI', 'MC', 60, null, null, 'A', 'act', '@onsemi/products/sensors/image-sensors/ar0144cs'],
            ['ar1335', 'AR1335', 4208, 3120, 1.1, 'RS', '1/3.2″', 'BSI', 'MC', 30, null, null, 'A', 'act', '@onsemi/products/sensors/image-sensors/ar1335'],
            ['ar0134', 'AR0134CS', 1280, 960, 3.75, 'GS', '1/3″', 'FSI', 'MC', 54, 12, null, 'A', 'act', 'https://docs.rs-online.com/5a5c/A700000008957762.pdf'],
            ['ar0135', 'AR0135CS', 1280, 960, 3.75, 'GS', '1/3″', 'FSI', 'MC', 54, 12, null, 'A', 'act', 'https://mm.digikey.com/Volume0/opasdata/d220001/medias/docus/7166/AR0135CSSM25SUEAH3-GEVB.pdf'],
            ['ar0330', 'AR0330CM', 2304, 1536, 2.2, 'RS', '1/3″', 'FSI', 'C', null, null, null, 'EOL', 'act', 'https://www.farnell.com/datasheets/2790747.pdf'],
            ['ar0237', 'AR0237', 1928, 1088, 3, 'RS', '1/2.7″', 'FSI', 'C', 60, null, null, 'EOL', 'act', '@onsemi/products/sensors/image-sensors/ar0237'],
            ['ar0234', 'AR0234CS', 1920, 1200, 3, 'GS', '1/2.6″', 'FSI', 'MC', 120, null, null, 'A', 'act', '@onsemi/products/sensors/image-sensors/ar0234cs'],
            ['ar0521', 'AR0521', 2592, 1944, 2.2, 'RS', '1/2.5″', 'BSI', 'MC', 60, null, null, 'A', 'act', '@onsemi/products/sensors/image-sensors/ar0521'],
            ['ar0522', 'AR0522', 2592, 1944, 2.2, 'RS', '1/2.5″', 'CMOS', 'MC', 60, null, null, 'A', 'act', '@onsemi/products/sensors/image-sensors/ar0522'],
            ['ar0821', 'AR0821CS', 3848, 2168, 2.1, 'RS', '1/1.7″', 'BSI', 'C', 60, 12, null, 'A', 'act', '@onsemi/download/public-data-sheet/pdf/ar0821-pd-d.pdf']
        ]],
        ['onsemi', 'Hyperlux LP', [
            ['ar0544', 'AR0544', 2592, 1944, 1.4, 'RS', '1/4.2″', 'SBSI', 'MC', 60, 10, 2023, 'A', 'act', '@onsemi/download/public-data-sheet/pdf/ar0544-pd-d.pdf'],
            ['ar0830', 'AR0830', 3840, 2160, 1.4, 'RS', '1/2.9″', 'SBSI', 'MC', 60, 10, 2023, 'A', 'act', '@onsemi/download/public-data-sheet/pdf/ar0830-pd-d.pdf'],
            ['ar2020', 'AR2020', 5120, 3840, 1.4, 'RS', '1/1.8″', 'SBSI', 'MC', 60, 10, 2023, 'A', 'act', '@onsemi/download/public-data-sheet/pdf/ar2020-pd-d.pdf']
        ]],
        ['onsemi', 'Hyperlux LH', [
            ['ar0822', 'AR0822', 3840, 2160, 2, 'RS', '1/1.8″', 'SBSI', 'MC', 60, 12, null, 'A', 'act', '@onsemi/download/public-data-sheet/pdf/ar0822-pd-d.pdf']
        ]],
        ['onsemi', 'VITA', [
            ['vita1300', 'VITA 1300', 1280, 1024, 4.8, 'GS', '1/2″', 'FSI', 'MC', 150, 10, 2009, 'A', 'act', '@onsemi/pdf/datasheet/noiv1sn1300a-d.pdf', 'NOIV1SN1300A-QDC NOIV1SE1300A-QDC NOIV2SN1300A-QDC NOIV2SE13'],
            ['vita2000', 'VITA 2000', 1920, 1200, 4.8, 'GS', '2/3″', 'FSI', 'MC', 92, 10, 2010, 'A', 'act', '@onsemi/pdf/datasheet/noiv1sn2000a-d.pdf', 'NOIV1SN2000A-QDC NOIV1SE2000A-QDC NOIV2SN2000A-QDC NOIV2SE20'],
            ['vita5000', 'VITA 5000', 2592, 2048, 4.8, 'GS', '1″', 'FSI', 'MC', 75, 10, 2010, 'EOL', 'act', '@onsemi/pdf/datasheet/noiv1sn5000a-d.pdf', 'NOIV1SN5000A-QDC NOIV1SE5000A-QDC'],
            ['vita25k', 'VITA 25K', 5120, 5120, 4.5, 'GS', '35 mm full frame', 'FSI', 'MC', 53, 10, 2010, 'A', 'act', '@onsemi/pdf/datasheet/noiv1sn025ka-d.pdf', 'NOIV1SN025KA-GTI NOIV1SE025KA-GTI NOIV1SN025KA-GWC NOIV1SN02']
        ]],
        ['onsemi', 'MT9', [
            ['mt9v022', 'MT9V022', 752, 480, 6, 'GS', '1/3″', 'FSI', 'MC', 60, 10, null, 'EOL', 'act', '@onsemi/pdf/datasheet/mt9v022-d.pdf'],
            ['mt9v024', 'MT9V024', 752, 480, 6, 'GS', '1/3″', 'FSI', 'MC', 60, 10, null, 'EOL', 'act', '@onsemi/pdf/datasheet/mt9v024-d.pdf'],
            ['mt9v032', 'MT9V032', 752, 480, 6, 'GS', '1/3″', 'FSI', 'MC', 60, 10, null, 'EOL', 'act', '@stvision/MT9V032_DS_D.pdf'],
            ['mt9v034', 'MT9V034', 752, 480, 6, 'GS', '1/3″', 'FSI', 'MC', 60, 10, null, 'EOL', 'act', '@onsemi/pdf/datasheet/mt9v034-d.pdf'],
            ['mt9m021', 'MT9M021 / MT9M031', 1280, 960, 3.75, 'GS', '1/3″', 'FSI', 'MC', 45, 12, null, '?', 'act', 'https://atta.szlcsc.com/upload/public/pdf/source/20241101/873E0CD4FE3031FF47943119C5F7AE12.pdf'],
            ['mt9m034', 'MT9M034', 1280, 960, 3.75, 'RS', '1/3″', 'FSI', 'MC', 45, 12, null, 'EOL', 'act', '@onsemi/pdf/datasheet/mt9m034-d.pdf'],
            ['mt9p001', 'MT9P001', 2592, 1944, 2.2, 'RS', '1/2.5″', 'FSI', 'C', 15, 12, null, 'EOL', 'act', '@onsemi/pdf/datasheet/mt9p001-d.pdf'],
            ['mt9p006', 'MT9P006', 2592, 1944, 2.2, 'RS', '1/2.5″', 'FSI', 'C', 15, 12, null, 'EOL', 'act', '@onsemi/pdf/datasheet/mt9p006-d.pdf'],
            ['mt9p031', 'MT9P031', 2592, 1944, 2.2, 'RS', '1/2.5″', 'FSI', 'MC', 14, 12, null, 'EOL', 'act', '@onsemi/pdf/datasheet/mt9p031-d.pdf'],
            ['mt9j003', 'MT9J003', 3664, 2748, 1.67, 'RS', '1/2.3″', 'FSI', 'MC', 15, 12, null, 'EOL', 'act', '@onsemi/pdf/datasheet/mt9j003-d.pdf'],
            ['mt9m001', 'MT9M001', 1280, 1024, 5.2, 'RS', '1/2″', 'FSI', 'M', 30, 10, null, 'EOL', 'act', '@onsemi/download/data-sheet/pdf/mt9m001-mono-d.pdf']
        ]],
        ['onsemi', 'KAI', [
            ['kai0340', 'KAI-0340', 640, 480, 7.4, 'IL', '1/3″', 'CCD', 'MC', 210, null, 2008, 'EOL', 'act', '@onsemi/download/data-sheet/pdf/kai-0340-d.pdf'],
            ['kai01050', 'KAI-01050', 1024, 1024, 5.5, 'IL', '1/2″', 'CCD', 'MC', 120, null, 2008, 'EOL', 'act', '@onsemi/download/data-sheet/pdf/kai-01050-d.pdf'],
            ['kai1020', 'KAI-1020', 1000, 1000, 7.4, 'IL', '2/3″', 'CCD', 'MC', 48, null, null, 'EOL', 'act', '@onsemi/pdf/datasheet/kai-1020-d.pdf'],
            ['kai02050', 'KAI-02050', 1600, 1200, 5.5, 'IL', '2/3″', 'CCD', 'MC', 68, null, null, 'EOL', 'act', '@onsemi/pdf/datasheet/kai-02050-d.pdf'],
            ['kai02150', 'KAI-02150', 1920, 1080, 5.5, 'IL', '2/3″', 'CCD', 'MC', 64, null, 2008, 'EOL', 'act', '@onsemi/download/data-sheet/pdf/kai-02150-d.pdf'],
            ['kai1010', 'KAI-1010', 1008, 1018, 9, 'IL', '1″', 'CCD', 'M', null, null, null, 'EOL', 'act', '@onsemi/pdf/datasheet/kai-1010-d.pdf'],
            ['kai2001', 'KAI-2001', 1600, 1200, 7.4, 'IL', '1″', 'CCD', 'MC', 30, null, null, 'EOL', 'act', '@onsemi/pdf/datasheet/kai-2001-d.pdf'],
            ['kai2020', 'KAI-2020', 1600, 1200, 7.4, 'IL', '1″', 'CCD', 'MC', 35, null, null, 'EOL', 'act', '@onsemi/pdf/datasheet/kai-2020-d.pdf'],
            ['kai04050', 'KAI-04050', 2336, 1752, 5.5, 'IL', '1″', 'CCD', 'MC', 32, null, null, 'EOL', 'act', '@onsemi/download/data-sheet/pdf/kai-04050-d.pdf'],
            ['kai2093', 'KAI-2093', 1920, 1080, 7.4, 'IL', null, 'CCD', 'MC', 30, null, null, 'EOL', 'act', '@onsemi/pdf/datasheet/kai-2093-d.pdf'],
            ['kai1003', 'KAI-1003', 1024, 1024, 12.8, 'IL', '4/3″', 'CCD', 'M', 30, null, null, 'EOL', 'act', '@onsemi/download/data-sheet/pdf/kai-1003-d.pdf'],
            ['kai04022', 'KAI-04022', 2048, 2048, 7.4, 'IL', '4/3″', 'CCD', 'MC', 16, null, null, 'EOL', 'act', '@onsemi/download/data-sheet/pdf/kai-04022-d.pdf'],
            ['kai04070', 'KAI-04070', 2048, 2048, 7.4, 'IL', '4/3″', 'CCD', 'MC', 28, null, null, 'EOL', 'act', '@onsemi/download/data-sheet/pdf/kai-04070-d.pdf'],
            ['kai08050', 'KAI-08050', 3296, 2472, 5.5, 'IL', '4/3″', 'CCD', 'MC', 16, null, 2009, 'EOL', 'act', '@onsemi/download/data-sheet/pdf/kai-08050-d.pdf'],
            ['kai08051', 'KAI-08051', 3296, 2472, 5.5, 'IL', '4/3″', 'CCD', 'MC', 16, null, null, 'EOL', 'act', '@onsemi/download/data-sheet/pdf/kai-08051-d.pdf'],
            ['kai16050', 'KAI-16050', 4896, 3264, 5.5, 'IL', 'APS-H', 'CCD', 'MC', 8, null, null, 'EOL', 'act', '@onsemi/pdf/datasheet/kai-16050-d.pdf'],
            ['kai16070', 'KAI-16070', 4864, 3232, 7.4, 'IL', '35 mm full frame', 'CCD', 'MC', 8, null, null, 'EOL', 'act', '@onsemi/pdf/datasheet/kai-16070-d.pdf'],
            ['kai16000', 'KAI-16000', 4872, 3248, 7.4, 'IL', '35 mm full frame', 'CCD', 'MC', 3, null, null, 'EOL', 'act', '@onsemi/pdf/datasheet/kai-16000-d.pdf'],
            ['kai11002', 'KAI-11002', 4008, 2672, 9, 'IL', '35 mm full frame', 'CCD', 'MC', 5, null, null, 'EOL', 'act', '@onsemi/pdf/datasheet/kai-11002-d.pdf'],
            ['kai29050', 'KAI-29050', 6576, 4384, 5.5, 'IL', '35 mm full frame', 'CCD', 'MC', 4, null, null, 'EOL', 'act', '@onsemi/download/data-sheet/pdf/kai-29050-d.pdf'],
            ['kai43140', 'KAI-43140', 8040, 5360, 4.5, 'IL', '35 mm full frame', 'CCD', 'MC', 4, null, null, 'EOL', 'act', '@onsemi/download/data-sheet/pdf/kai-43140-d.pdf'],
            ['kai47051', 'KAI-47051', 8856, 5280, 5.5, 'IL', null, 'CCD', 'MC', 7, null, null, 'EOL', 'act', '@onsemi/download/data-sheet/pdf/kai-47051-d.pdf']
        ]],
        ['onsemi', 'KAF', [
            ['kaf0402', 'KAF-0402', 768, 512, 9, 'FF', '1/2″', 'CCD', 'M', null, null, null, 'EOL', 'act', '@onsemi/pdf/datasheet/kaf-0402-d.pdf'],
            ['kaf0261', 'KAF-0261', 512, 512, 20, 'FF', null, 'CCD', 'M', null, null, null, 'EOL', 'act', '@onsemi/pdf/datasheet/kaf-0261-d.pdf'],
            ['kaf1603', 'KAF-1603', 1536, 1024, 9, 'FF', '1″', 'CCD', 'M', null, null, null, 'EOL', 'act', '@onsemi/pdf/datasheet/kaf-1603-d.pdf'],
            ['kaf3200', 'KAF-3200', 2184, 1472, 6.8, 'FF', '4/3″', 'CCD', 'M', null, null, null, 'EOL', 'act', '@onsemi/pdf/datasheet/kaf-3200-d.pdf'],
            ['kaf8300', 'KAF-8300', 3326, 2504, 5.4, 'FF', '4/3″', 'CCD', 'MC', 2.9, null, null, 'EOL', 'act', '@onsemi/pdf/datasheet/kaf-8300-d.pdf'],
            ['kaf6303', 'KAF-6303', 3072, 2048, 9, 'FF', 'APS-H', 'CCD', 'M', null, null, null, 'EOL', 'act', '@onsemi/pdf/datasheet/kaf-6303-d.pdf'],
            ['kaf16200', 'KAF-16200', 4500, 3600, 6, 'FF', 'APS-H', 'CCD', 'MC', 1.23, null, null, 'EOL', 'act', '@onsemi/download/data-sheet/pdf/kaf-16200-d.pdf'],
            ['kaf1001', 'KAF-1001', 1024, 1024, 24, 'FF', 'APS-H', 'CCD', 'M', null, null, null, 'EOL', 'act', '@onsemi/pdf/datasheet/kaf-1001-d.pdf'],
            ['kaf09001', 'KAF-09001', 3024, 3024, 12, 'FF', 'medium format 645, 1.3× crop', 'CCD', 'M', null, null, null, 'EOL', 'act', '@onsemi/pdf/datasheet/kaf-09001-d.pdf'],
            ['kaf09000', 'KAF-09000', 3056, 3056, 12, 'FF', 'medium format 645, 1.3× crop', 'CCD', 'M', 0.4, null, null, 'EOL', 'act', '@onsemi/pdf/datasheet/kaf-09000-d.pdf'],
            ['kaf16801', 'KAF-16801', 4096, 4096, 9, 'FF', 'medium format 645, 1.3× crop', 'CCD', 'M', null, null, null, 'EOL', 'act', '@onsemi/pdf/datasheet/kaf-16801-d.pdf'],
            ['kaf16803', 'KAF-16803', 4096, 4096, 9, 'FF', 'medium format 645, 1.3× crop', 'CCD', 'M', 0.2, null, null, 'EOL', 'act', '@onsemi/pdf/datasheet/kaf-16803-d.pdf'],
            ['kaf40000', 'KAF-40000', 7304, 5478, 6, 'FF', 'medium format 645, 1.3× crop', 'CCD', 'C', null, null, null, 'EOL', 'act', '@onsemi/pdf/datasheet/kaf-40000-d.pdf'],
            ['kaf50100', 'KAF-50100', 8176, 6132, 6, 'FF', 'medium format 645, 1.1× crop', 'CCD', 'MC', 1, null, null, 'EOL', 'act', '@onsemi/pdf/datasheet/kaf-50100-d.pdf'],
            ['kaf4320', 'KAF-4320', 2084, 2085, 24, 'FF', 'medium format 645', 'CCD', 'M', null, null, null, 'EOL', 'act', '@onsemi/pdf/datasheet/kaf-4320-d.pdf']
        ]],
        ['Gpixel', 'GMAX', [
            ['gmax2505', 'GMAX2505', 2600, 2160, 2.5, 'GS', '1/2″', 'CMOS', 'MC', 290, 10, 2018, 'A', 'act', '@gpixel/pro_details_1181.html'],
            ['gmax4002', 'GMAX4002', 2048, 1200, 4, 'GS', '1/1.7″', 'CMOS', 'MC', 344, 10, 2022, 'A', 'act', '@gpixel/pro_details_1171.html'],
            ['gmax3405', 'GMAX3405', 2448, 2048, 3.4, 'GS', '2/3″', 'CMOS', 'MC', 264, null, 2023, 'A', 'act', '@gpixel/pro_details_11246.html'],
            ['gmax2509', 'GMAX2509', 4200, 2160, 2.5, 'GS', '2/3″', 'CMOS', 'MC', 290, 10, 2018, 'A', 'act', '@gpixel/pro_details_1182.html'],
            ['gmax2518', 'GMAX2518', 4508, 4096, 2.5, 'GS', '1″', 'CMOS', 'MC', 139, 10, 2020, 'A', 'act', '@gpixel/pro_details_1184.html'],
            ['gmax3412', 'GMAX3412', 4096, 3072, 3.4, 'GS', '1.1″', 'CMOS', 'MC', 150, null, 2023, 'A', 'act', '@gpixel/pro_details_11247.html'],
            ['gmax2424bsi', 'GMAX2424BSI', 6016, 4096, 2.4, 'RS', '1.1″', 'BSI', 'MC', 60, 10, 2025, 'A', 'act', '@gpixel/pro_details_11311.html'],
            ['gmax3809', 'GMAX3809', 4096, 2160, 3.8, 'GS', '1.1″', 'CMOS', 'MC', 54, 12, 2021, 'A', 'act', '@gpixel/pro_details_1183.html'],
            ['gmax0505', 'GMAX0505', 5120, 5120, 2.5, 'GS', '1.1″', 'CMOS', 'MC', 150, 10, 2018, 'A', 'act', '@gpixel/pro_details_11126.html'],
            ['gmax3413', 'GMAX3413', 5900, 2160, 3.4, 'GS', '4/3″', 'CMOS', 'MC', 32, 12, 2023, 'A', 'act', '@gpixel/pro_details_11245.html'],
            ['gmax4416', 'GMAX4416', 4096, 4096, 4.4, 'GS', '1.6″', 'CMOS', 'MC', 80, 12, 2024, 'A', 'act', '@gpixel/pro_details_11251.html'],
            ['gmax0806', 'GMAX0806', 7915, 5436, 2.8, 'GS', 'APS-C', 'CMOS', 'MC', 17, 12, 2017, '?', 'act', '@archive/20230930004352/https://www.gpixel.com/products/area-scan-en/gmax/gmax0806-2-8-%CE%BCm-43mp-global-shutter-image-sensor/'],
            ['gmax15271bsi', 'GMAX15271BSI', 19376, 14000, 1.5, 'RS', '2.24″', 'BSI', 'MC', 8.5, 12, 2025, 'A', 'act', '@gpixel/pro_details_11296.html'],
            ['gmax3265', 'GMAX3265', 9344, 7000, 3.2, 'GS', '2.3″', 'CMOS', 'MC', 71, 10, 2018, 'A', 'act', '@gpixel/pro_details_1187.html'],
            ['gmax32103', 'GMAX32103', 11276, 9200, 3.2, 'GS', '2.9″', 'CMOS', 'MC', 24, 12, 2020, 'A', 'act', '@gpixel/pro_details_1188.html'],
            ['gmax4651', 'GMAX4651', 8424, 6032, 4.6, 'GS', '35 mm full frame', 'CMOS', 'MC', 30, 12, 2018, 'A', 'act', '@gpixel/pro_details_1186.html'],
            ['gmax32152', 'GMAX32152', 16556, 9200, 3.2, 'GS', '3.7″', 'CMOS', 'MC', 16, 12, 2021, 'A', 'act', '@gpixel/pro_details_1189.html']
        ]],
        ['Gpixel', 'GSPRINT', [
            ['gsprint4502', 'GSPRINT4502', 2048, 1216, 4.5, 'GS', '2/3″', 'CMOS', 'MC', 3462, 8, 2022, 'A', 'act', '@gpixel/pro_details_1190.html'],
            ['gsprint6502bsi', 'GSPRINT6502BSI', 2048, 1152, 6.5, 'GS', '1″', 'BSI', 'M', 1498, 10, 2024, 'A', 'act', '@gpixel/pro_details_11266.html'],
            ['gsprint4510', 'GSPRINT4510', 4608, 2176, 4.5, 'GS', '4/3″', 'CMOS', 'MC', 1920, 8, 2021, 'A', 'act', '@gpixel/pro_details_1191.html'],
            ['gsprint4521', 'GSPRINT4521', 5120, 4096, 4.5, 'GS', '1.84″', 'CMOS', 'MC', 1000, 8, 2020, 'A', 'act', '@gpixel/pro_details_1192.html'],
            ['gsprint5514bsi', 'GSPRINT5514BSI', 4608, 3072, 5.5, 'GS', 'APS', 'BSI', 'MC', 670, 10, 2024, 'A', 'act', '@gpixel/pro_details_11276.html'],
            ['gsprint2001bsi', 'GSPRINT2001BSI', 1280, 1024, 20, 'GS', null, 'BSI', 'MC', 6400, 10, 2025, 'A', 'act', '@gpixel/pro_details_11313.html']
        ]],
        ['Gpixel', 'GSENSE', [
            ['gsense2011', 'GSENSE2011', 2048, 1152, 6.5, 'RS', '1″', 'CMOS', 'MC', 668, null, 2015, '?', 'act', '@archive/20210624204909/https://www.gpixel.com/products/area-scan-en/gsense-series/gsense2011e/'],
            ['gsense2020-fsi', 'GSENSE2020', 2048, 2048, 6.5, 'RS', '1.2″', 'CMOS', 'MC', 370, 10, 2015, '?', 'act', '@archive/20210624222341/https://www.gpixel.com/products/area-scan-en/gsense-series/gsense2020e/'],
            ['gsense2020', 'GSENSE2020BSI', 2048, 2048, 6.5, 'RS', '1.2″', 'BSI', 'M', 74, 11, 2017, 'A', 'act', '@gpixel/pro_details_1194.html'],
            ['gsense6504bsi', 'GSENSE6504BSI', 2048, 2048, 6.5, 'RS', '1.2″', 'BSI', 'M', 300, 12, 2025, 'A', 'act', '@gpixel/pro_details_11303.html'],
            ['gsense6510bsi', 'GSENSE6510BSI', 3200, 3200, 6.5, 'RS', '1.9″', 'BSI', 'M', 500, 8, 2024, 'A', 'act', '@gpixel/pro_details_11256.html'],
            ['gsense3243bsi', 'GSENSE3243BSI', 8192, 5232, 3.2, 'RS', '1.9″', 'BSI', 'M', 100, 14, 2024, 'A', 'act', '@gpixel/pro_details_11250.html'],
            ['gsense400-fsi', 'GSENSE400', 2048, 2048, 11, 'RS', '2″', 'CMOS', 'M', 48, 12, 2014, '?', 'act', '@archive/20210624204012/https://www.gpixel.com/products/area-scan-en/gsense-series/gsense400fsi/'],
            ['gsense400bsi', 'GSENSE400BSI', 2048, 2048, 11, 'RS', '2″', 'BSI', 'M', 48, 12, 2015, 'A', 'act', '@gpixel/pro_details_1196.html'],
            ['gsense4040-fsi', 'GSENSE4040', 4096, 4096, 9, 'RS', '3.3″', 'CMOS', 'M', 24, 12, null, '?', 'act', '@archive/20231210052856/https://www.gpixel.com/en/pro_details_1199.html'],
            ['gsense4040bsi', 'GSENSE4040BSI', 4096, 4096, 9, 'RS', '3.3″', 'BSI', 'M', 24, 12, 2020, 'A', 'act', '@gpixel/pro_details_11100.html'],
            ['gsense1516bsi', 'GSENSE1516BSI', 4096, 4096, 15, 'RS', null, 'BSI', 'M', 9, null, 2020, '?', 'act', '@archive/20210724083028/https://www.gpixel.com/products/area-scan-en/gsense/gsense1516bsi/'],
            ['gsense6060', 'GSENSE6060', 6144, 6144, 10, 'RS', '5.4″', 'CMOS', 'M', 44, 12, null, 'A', 'act', '@gpixel/pro_details_11101.html'],
            ['gsense6060bsi', 'GSENSE6060BSI', 6144, 6144, 10, 'RS', '5.4″', 'BSI', 'M', 26, 12, 2020, 'A', 'act', '@gpixel/pro_details_11106.html'],
            ['gsense1517bsi', 'GSENSE1517BSI', 4116, 4100, 15, 'RS', null, 'BSI', 'M', 4, 12, 2025, 'A', 'act', '@gpixel/pro_details_11292.html'],
            ['gsense64105bsi', 'GSENSE64105BSI', 10240, 10240, 6.4, 'RS', null, 'BSI', 'M', 1.25, null, 2026, 'A', 'act', '@gpixel/pro_details_11314.html'],
            ['gsense1081bsi', 'GSENSE1081BSI', 8900, 9120, 10, 'RS', '7.96″', 'BSI', 'M', 0.94, 15, 2022, 'A', 'act', '@gpixel/pro_details_11108.html']
        ]],
        ['Gpixel', 'GLUX', [
            ['glux9701bsi', 'GLUX9701BSI', 1280, 1024, 9.76, 'RS', '1″', 'BSI', 'M', 30, null, 2021, 'A', 'act', '@gpixel/pro_details_11109.html'],
            ['glux1605bsi', 'GLUX1605BSI', 800, 600, 16, 'RS', '1″', 'BSI', 'M', 60, 12, 2022, 'A', 'act', '@gpixel/pro_details_11110.html']
        ]],
        ['Gpixel', 'GCINE', [
            ['gcine3243', 'GCINE3243', 8192, 5232, 3.2, 'RS', 'APS-C', 'CMOS', 'MC', 60, 14, 2023, 'A', 'act', '@gpixel/pro_details_11237.html'],
            ['gcine4349', 'GCINE4349', 8192, 6000, 4.3, 'RS', '35 mm full frame', 'CMOS', 'MC', 120, 16, 2021, 'A', 'act', '@gpixel/pro_details_11117.html', 'GSENSE4349BSI-CVM-NLT-BUD GSENSE4349BSI-CVM-HLT-BUD']
        ]],
        ['Gpixel', 'GXS', [
            ['gxs1508', 'GXS1508 / GXSM1508', 400, 400, 1.5, 'RS', '1/19″', 'CMOS', 'C', 30, null, null, 'A', 'act', '@gpixel/pro_details_11289.html', 'GXS1508-BBC-NQT-AUD GXSM1508-BBC-NQT-AUD']
        ]],
        ['Teledyne e2v', 'Emerald', [
            ['emerald-2m', 'Emerald 2M', 1920, 1080, 2.8, 'GS', '1/2.9″', 'CMOS', 'MC', 80, 10, 2018, '?', 'act', '@archive/20230926212748/https://imaging.teledyne-e2v.com/content/uploads/2019/01/2022-06-06_e2v_Emerald_2M_Spec-Sheet_web.pdf', 'EV2S02M EV2S02MB-FM20150-T EV2S02MB-FM20350-T EV2S02MB-CM201'],
            ['emerald-3m2', 'Emerald 3.2M', 2048, 1536, 2.8, 'GS', '1/2.5″', 'CMOS', 'MC', 68, 10, 2020, '?', 'act', '@archive/20230326205325/https://imaging.teledyne-e2v.com/content/uploads/2019/01/2022-06-08_e2v_Emerald_3.2-and-5M_Spec-Sheet_web.pdf', 'EV2S3M2 EV2S3M2B-FM20150-T EV2S3M2B-FM20350-T EV2S3M2B-CM201'],
            ['emerald-5m', 'Emerald 5M', 2560, 1936, 2.8, 'GS', '1/1.8″', 'CMOS', 'MC', 54, 10, 2018, '?', 'act', '@archive/20230326205325/https://imaging.teledyne-e2v.com/content/uploads/2019/01/2022-06-08_e2v_Emerald_3.2-and-5M_Spec-Sheet_web.pdf', 'EV2S05M EV2S05MB-FM20150-T EV2S05MB-FM20350-T EV2S05MB-CM201'],
            ['emerald-8m9', 'Emerald 8.9M', 4096, 2160, 2.8, 'GS', '2/3″', 'CMOS', 'MC', 91, 10, 2018, '?', 'act', '@archive/20240616075337/https://imaging.teledyne-e2v.com/content/uploads/2019/01/2022-06-06_e2v_Emerald-8.9M-10MV_Spec-Sheet_web.pdf', 'EV2S8M9 EV2S8M9B-CLV0151-T EV2S8M9B-CLV0351-T EV2S8M9C-CLV01'],
            ['emerald-10m', 'Emerald 10M', 4096, 2460, 2.8, 'GS', '1″', 'CMOS', 'MC', 80, 10, null, '?', 'act', '@archive/20240616075337/https://imaging.teledyne-e2v.com/content/uploads/2019/01/2022-06-06_e2v_Emerald-8.9M-10MV_Spec-Sheet_web.pdf', 'EV2S10M EV2S10MB-CLV0151-T EV2S10MB-CLV0351-T EV2S10MC-CLV01'],
            ['emerald-12m', 'Emerald 12M', 4096, 3072, 2.8, 'GS', '1″', 'CMOS', 'MC', 63, 10, 2016, '?', 'act', '@archive/20211015233517/https://imaging.teledyne-e2v.com/content/uploads/2019/01/2021-09-03_e2v_Emerald_12-16M_Spec-Sheet_web.pdf', 'EV2S12M EV2S12MB-CLV0151-T EV2S12MB-CLV0351-T EV2S12MC-CLV01'],
            ['emerald-16m', 'Emerald 16M', 4096, 4096, 2.8, 'GS', '1″', 'CMOS', 'MC', 47, 10, 2016, '?', 'act', '@archive/20211015233517/https://imaging.teledyne-e2v.com/content/uploads/2019/01/2021-09-03_e2v_Emerald_12-16M_Spec-Sheet_web.pdf', 'EV2S16M EV2S16MB-CLV0151-T EV2S16MB-CLV0351-T EV2S16MC-CLV01'],
            ['emerald-36m', 'Emerald 36M', 6144, 6144, 2.5, 'GS', '4/3″', 'CMOS', 'MC', 87, 10, 2020, 'A', 'act', '@teledyne/emerald/?model=EV2S36MB-CLV0650-T', 'EV2S36M EV2S36MB-CLV0350-T EV2S36MB-CLV0650-T EV2S36MC-CLV03'],
            ['emerald-67m', 'Emerald 67M', 8192, 8192, 2.5, 'GS', 'APS-C', 'CMOS', 'MC', 65, 10, 2018, 'A', 'act', '@teledyne/emerald/?model=EV2S67MB-CLV0650-T', 'EV2S67M EV2S67MB-CLV0350-T EV2S67MB-CLV0650-T EV2S67MC-CLV03']
        ]],
        ['Teledyne e2v', 'Emerald Gen2', [
            ['emerald-gen2-8m9', 'Emerald Gen2 8.9M', 4096, 2160, 2.8, 'GS', '2/3″', 'CMOS', 'MC', 100, 10, 2023, 'A', 'act', '@teledyne/emerald-gen-2/?model=EV2S8M9B-CLM1350-T', 'EV2S8M9B-CLM1150-T EV2S8M9B-CLM1350-T EV2S8M9B-CLM0150-T EV2'],
            ['emerald-gen2-12m', 'Emerald Gen2 12M', 4096, 3072, 2.8, 'GS', '1″', 'CMOS', 'MC', 70, 10, 2023, 'A', 'act', '@teledyne/emerald-gen-2/?model=EV2S12MB-CLM1350-T', 'EV2S12MB-CLM1150-T EV2S12MB-CLM1350-T EV2S12MB-CLM0150-T EV2']
        ]],
        ['Teledyne e2v', 'Flash', [
            ['flash-1k2', 'Flash 1K2', 1150, 1160, 6, 'GS', '2/3″', 'CMOS', 'C', 3000, 8, 2026, 'A', 'act', 'https://flir.netx.net/file/asset/60275/original/attachment'],
            ['flash-2k', 'Flash 2K', 2048, 1080, 6, 'GS', null, 'CMOS', 'M', 1500, 8, 2019, 'A', 'act', 'https://flir.netx.net/file/asset/60275/original/attachment', 'EV3S2M0B-CLVFL20-T'],
            ['flash-4k', 'Flash 4K', 4096, 1080, 6, 'GS', 'APS-C', 'CMOS', 'M', 1800, 8, 2019, 'A', 'act', 'https://flir.netx.net/file/asset/60275/original/attachment', 'EV3S4M0B-CLVFL40-T'],
            ['flash-8k', 'Flash 8K', 8192, 1080, 6, 'GS', null, 'CMOS', 'M', 1800, 8, 2026, 'A', 'act', 'https://flir.netx.net/file/asset/60275/original/attachment']
        ]],
        ['Teledyne e2v', 'Jade', [
            ['jade-ev76c454', 'Jade 0.5M', 860, 640, 5.8, 'GS', '1/2.9″', 'CMOS', 'MC', 60, 8, null, 'A', 'act', 'https://flir.netx.net/file/asset/60275/original/attachment', 'EV76C454']
        ]],
        ['Teledyne e2v', 'Lince', [
            ['lince-1m3', 'Lince 1M3', 1280, 1024, 10, 'GS', '1″', 'CMOS', 'M', 980, 12, null, '?', 'act', '@archive/20240615191133/https://imaging.teledyne-e2v.com/content/uploads/2019/08/2022-06-06_e2v_Lince-1M3_Spec-Sheet_web.pdf', 'L13M1VON'],
            ['lince-5m', 'Lince5M', 2560, 2048, 5, 'GS', '1″', 'CMOS', 'MC', 250, 12, 2013, 'A', 'act', '@teledyne/lince/?model=L181', 'L181'],
            ['lince-6m5', 'Lince6M5', 2560, 2560, 5, 'GS', '1″', 'CMOS', 'MC', 170, 12, null, 'A', 'act', '@teledyne/lince/?model=L6M1V5', 'L6M1V5'],
            ['lince-11m', 'Lince11M', 4480, 2496, 6, 'GS', null, 'CMOS', 'M', 609, 10, 2018, 'A', 'act', '@teledyne/lince/?model=EV2S11MB-CLV0500-T', 'EV2S11M EV2S11MB-CLV0500-T']
        ]],
        ['Teledyne e2v', 'Nexora', [
            ['nexora-12m', 'Nexora 12M', 4096, 3072, 3.2, 'GS', '1″', 'SBSI', 'MC', 240, 10, 2026, 'A', 'act', '@teledyne/nexora/?model=EV2S12MB-CLV2150-T', 'EV2S12MB-CLV2150-T EV2S12MC-CLV2150-T'],
            ['nexora-16m', 'Nexora 16M', 4096, 4096, 3.2, 'GS', '1″', 'SBSI', 'MC', 180, 10, 2026, 'A', 'act', '@teledyne/nexora/?model=EV2S16MB-CLV2150-T', 'EV2S16MB-CLV2150-T EV2S16MC-CLV2150-T']
        ]],
        ['Teledyne e2v', 'Onyx', [
            ['ev76c664', 'Onyx 1.3M', 1280, 1024, 10, 'GS', '1″', 'CMOS', 'M', 100, 12, 2015, '?', 'act', '@archive/20221207165827/https://imaging.teledyne-e2v.com/content/uploads/2019/01/2022-06-06_e2v_Onyx_Spec-Sheet_web.pdf', 'EV76C664 EV76C664ABT-RTR EV76C664AMT-RTR']
        ]],
        ['Teledyne e2v', 'OnyxMax', [
            ['onyxmax', 'OnyxMax 1.3M', 1280, 1024, 10, 'GS', '1″', 'CMOS', 'M', 120, null, 2024, 'A', 'act', '@teledyne/onyxmax/?vertical=tvs-e2v&segment=tvs']
        ]],
        ['Teledyne e2v', 'Ruby', [
            ['ev76c661', 'Ruby 1.3M global shutter', 1280, 1024, 5.3, 'GS', '1/1.8″', 'CMOS', 'MC', 60, 10, 2011, 'A', 'act', '@teledyne/ruby/?model=EV76C661', 'EV76C661 EV76C661ABT EV76C661ACT'],
            ['ev76c660', 'Ruby 1.3M rolling shutter', 1280, 1024, 5.3, 'RS', '1/1.8″', 'CMOS', 'MC', 60, 10, 2011, 'A', 'act', '@teledyne/ruby/?model=EV76C660', 'EV76C660 EV76C660ABT EV76C660ACT']
        ]],
        ['Teledyne e2v', 'Sapphire', [
            ['ev76c541', 'Sapphire WVGA', 752, 480, 4.5, 'GS', '1/4″', 'CMOS', 'MC', 125, 10, 2015, '?', 'act', '@archive/20190921074810/https://imaging.teledyne-e2v.com/content/uploads/2019/08/39660_Teledyne-e2v_CMOS-Sensor-Guide_August-2019_v2_AW_WEB_e2v.pdf', 'EV76C541'],
            ['ev76c560', 'Sapphire 1.3M', 1280, 1024, 5.3, 'GS', '1/1.8″', 'CMOS', 'MC', 60, 10, 2009, 'A', 'act', '@teledyne/sapphire/?model=EV76C560', 'EV76C560 EV76C560ABT-EQV EV76C560ACT-EQV'],
            ['ev76c570', 'Sapphire 2M', 1600, 1200, 4.5, 'GS', '1/1.8″', 'CMOS', 'MC', 60, 10, 2011, 'A', 'act', '@teledyne/sapphire/?model=EV76C570', 'EV76C570 EV76C570ABT-EQT EV76C570ACT-EQT']
        ]],
        ['Teledyne e2v', 'Snappy', [
            ['snappy-2m', 'Snappy 2M', 1920, 1080, 2.8, 'GS', '1/2.9″', 'CMOS', 'MC', 80, 10, 2018, '?', 'act', '@archive/20240616071033/https://imaging.teledyne-e2v.com/content/uploads/2019/02/2022-06-08_e2v_Snappy-2M_Spec-Sheet_web.pdf', 'EV2S02MB-FM20100-T EV2S02MB-FM20300-T EV2S02MC-FM20100-T EV2'],
            ['snappy-5m', 'Snappy 5M', 2560, 1936, 2.8, 'GS', '1/1.8″', 'CMOS', 'MC', 54, 10, 2018, '?', 'act', '@archive/20240414200706/https://imaging.teledyne-e2v.com/content/uploads/2019/02/2022-06-08_e2v_Snappy-5M_Spec-Sheet_web.pdf', 'EV2S05MB-FM20100-T EV2S05MB-FM20300-T EV2S05MC-FM20100-T EV2']
        ]],
        ['Teledyne e2v', 'Snappy Wide', [
            ['snappy-wide-16m', 'Snappy Wide 16M', 8192, 2000, 2.5, 'GS', null, 'CMOS', 'MC', 130, 10, 2023, 'A', 'act', '@teledyne/snappy-wide/?model=EV2S16MB-CLV0001-T', 'EV2S16MB-CLV0001-T EV2S16MB-CLV0011-T EV2S16MC-CLV0001-T EV2'],
            ['snappy-wide-28m', 'Snappy Wide 28M', 8192, 3500, 2.5, 'GS', null, 'CMOS', 'MC', 75, 10, 2023, 'A', 'act', '@teledyne/snappy-wide/?model=EV2S28MB-CLV0001-T', 'EV2S28MB-CLV0001-T EV2S28MB-CLV0011-T EV2S28MC-CLV0001-T EV2'],
            ['snappy-wide-35m', 'Snappy Wide 35M', 8192, 4320, 2.5, 'GS', null, 'CMOS', 'MC', 65, 10, 2023, 'A', 'act', '@teledyne/snappy-wide/?model=EV2S35MB-CLV0001-T', 'EV2S35MB-CLV0001-T EV2S35MB-CLV0011-T EV2S35MC-CLV0001-T EV2']
        ]],
        ['Teledyne e2v', 'Topaz', [
            ['topaz-1m5', 'Topaz 1.5M', 1920, 800, 2.5, 'GS', '1/3.2″', 'CMOS', 'MC', 130, 8, 2021, 'A', 'act', '@teledyne/topaz/?model=EV2S1M5B-PM23001-T', 'EV2S1M5 EV2S1M5B-PM23001-T EV2S1M5B-PM23000-T EV2S1M5B-PM230'],
            ['topaz-2m', 'Topaz 2M', 1920, 1080, 2.5, 'GS', '1/3.2″', 'CMOS', 'MC', 100, 8, 2021, 'A', 'act', '@teledyne/topaz/?model=EV2S02MB-PM23001-T', 'EV2S02M PM23 EV2S02MB-PM23001-T EV2S02MB-PM23000-T EV2S02MB-']
        ]],
        ['Teledyne e2v', 'Topaz5D', [
            ['topaz5d', 'Topaz5D', 1920, 1080, 2.5, 'GS', '1/3.2″', 'CMOS', 'MC', 65, 10, 2024, 'A', 'act', '@teledyne/topaz5d/?model=EV2S02MB-PM26201-T', 'EV2S02MB-PM26200-T EV2S02MB-PM26201-T EV2S02MC-PM26100-T EV2']
        ]],
        ['ams OSRAM', 'CHR', [
            ['chr71000', 'CHR71000', 10000, 7096, 3.1, 'RS', '35 mm full frame', 'FSI', 'MC', 3, null, null, 'A', 'act', '@ams/ams-chr71000', 'CHR70M']
        ]],
        ['ams OSRAM', 'CMV', [
            ['cmv300', 'CMV300', 648, 488, 7.4, 'GS', '1/3″', 'FSI', 'MC', 480, 12, 2011, 'EOL', 'act', '@ams/ams-cmv300'],
            ['cmv2000', 'CMV2000', 2048, 1088, 5.5, 'GS', '2/3″', 'FSI', 'MC', 340, 10, 2009, 'A', 'act', '@ams/ams-cmv2000'],
            ['cmv4000', 'CMV4000', 2048, 2048, 5.5, 'GS', '1″', 'FSI', 'MC', 180, 10, 2009, 'A', 'eff', '@ams/ams-cmv4000'],
            ['cmv8000', 'CMV8000', 3360, 2496, 5.5, 'GS', '4/3″', 'FSI', 'MC', 104, 10, 2014, 'EOL', 'eff', '@ams/ams-cmv8000'],
            ['cmv12000', 'CMV12000', 4096, 3072, 5.5, 'GS', null, 'FSI', 'MC', 300, 10, 2012, 'A', 'eff', '@ams/ams-cmv12000'],
            ['cmv20000', 'CMV20000', 5120, 3840, 6.4, 'GS', '35 mm full frame', 'FSI', 'MC', 30, 12, 2012, 'A', 'eff', '@ams/ams-cmv20000'],
            ['cmv50000', 'CMV50000', 7920, 6004, 4.6, 'GS', '35 mm full frame', 'FSI', 'MC', 30, 12, 2016, 'A', 'eff', '@ams/ams-cmv50000']
        ]],
        ['ams OSRAM', 'CSG', [
            ['csg8k', 'CSG8K', 3840, 2160, 3.2, 'GS', '3/4″', 'CMOS', 'MC', 231, 10, 2021, 'A', 'act', '@ams/ams-csg8k-1-global-shutter-image-sensor'],
            ['csg14k', 'CSG14K', 3840, 3584, 3.2, 'GS', '1″', 'CMOS', 'MC', 140, 10, 2021, 'A', 'act', '@ams/ams-csg14k-1-global-shutter-image-sensor']
        ]],
        ['ams OSRAM', 'Mira', [
            ['mira016', 'Mira016', 400, 400, 2.79, 'GS', '1/11.6″', 'SBSI', 'M', 360, 10, null, 'A', 'act', '@ams/ams-mira016-cmos-image-sensor'],
            ['mira050', 'Mira050', 576, 768, 2.79, 'GS', '1/7″', 'SBSI', 'MC', 200, null, 2023, 'A', 'act', '@ams/ams-mira050-cmos-image-sensor'],
            ['mira130', 'Mira130', 1080, 1280, 2.7, 'GS', '1/4″', 'CMOS', 'M', 120, 10, null, 'EOL', 'eff', '@ams/ams-mira130'],
            ['mira220', 'Mira220', 1600, 1400, 2.79, 'GS', '1/2.7″', 'SBSI', 'MC', 90, 12, 2022, 'A', 'act', '@ams/ams-mira220']
        ]],
        ['ams OSRAM', 'NanEye', [
            ['naneye2d', 'NanEye2D', 249, 250, 3, 'RS', '1/15″', 'CMOS', 'MC', 62, 10, null, 'A', 'act', '@ams/ams-naneye2d-miniature-camera-module', 'NE2D_CHIP_B&W_SGA NE2D_RGB_V90F2.7_2m NE2D_RGB_V120F2.8_2m'],
            ['naneyec', 'NanEyeC', 320, 320, 2.4, 'RS', '1/15″', 'FSI', 'MC', 58, null, 2019, 'A', 'act', '@ams/ams-naneyec-integrated-camera-module', 'NEC_HLCX-00 NEC_HLBX-00'],
            ['naneyem', 'NanEyeM', 320, 320, 2.4, 'RS', '1/15″', 'FSI', 'C', 49, null, 2018, 'A', 'act', '@ams/ams-naneyem-miniature-camera-modules', 'NEM_RGB_2M_FOV120_F4.0 NEM_RGB_2.5M_FOV120_F4.0']
        ]],
        ['Canon', 'Global-shutter CMOS', [
            ['canon-3u5mgxs', '3U5MGXS', 2592, 2056, 3.4, 'GS', '2/3″', 'CMOS', 'MC', 120, 12, 2018, '?', 'eff', 'https://www.photonicsonline.com/doc/megapixel-global-shutter-cmos-sensor-3u5mgxs-0001', 'LI5010SA LI5020SA LI5010SAM LI5010SAC LI5010SAI LI5020SAM LI'],
            ['canon-li5040sa', 'LI5040SA', 2592, 2056, 3.4, 'GS', '2/3″', 'CMOS', 'MC', 120, 12, null, 'A', 'eff', '@canon/canon-li5040-5m-cmos-sensor/'],
            ['canon-li5070sa', 'LI5070SA', 4288, 2398, 6.4, 'GS', 'Super 35 mm', 'CMOS', 'C', 60, 12, null, 'A', 'eff', '@canon/canon-li5070sa-cmos-sensor/'],
            ['canon-li5030sa', 'LI5030SA', 5688, 3336, 6.4, 'GS', '35 mm full frame', 'CMOS', 'MC', 57.99, 12, 2022, 'A', 'eff', 'https://canon.jp/biz/product/indtech/cmos/lineup/li5030/spec', '19MP']
        ]],
        ['Canon', 'Rolling-shutter CMOS', [
            ['canon-li7060sa', 'LI7060SA', 1936, 1456, 3.2, 'RS', '1/2.32″', 'CMOS', 'C', 60, null, null, 'A', 'eff', '@canon/canon-li7060-hdr-cmos-sensor/'],
            ['canon-li7050sa', 'LI7050SA', 1936, 1096, 4.1, 'RS', '1/1.8″', 'CMOS', 'C', 60, 12, 2020, 'A', 'eff', '@canon/canon-li7050-2m-cmos-sensor/'],
            ['canon-li7070sa', 'LI7070SA', 1936, 1096, 4.1, 'RS', '1/1.8″', 'CMOS', 'MC', 60, 12, null, 'A', 'eff', '@canon/canon-li7070sa-cmos-sensor/'],
            ['canon-li7030sa', 'LI7030SA', 4000, 3000, 3.2, 'RS', '1″', 'CMOS', 'C', 24, 12, null, 'A', 'eff', 'https://canon.jp/biz/product/indtech/cmos/lineup/1-12m/spec', '12MP'],
            ['canon-li7080sa', 'LI7080SA', 4536, 2400, 6.4, 'RS', 'Super 35 mm', 'CMOS', 'C', 120, 14, 2022, 'A', 'eff', '@canon/canon-li7080sa-cmos-sensor/']
        ]],
        ['Canon', 'Ultra-high-resolution CMOS', [
            ['canon-li8020sa', 'LI8020SA', 19568, 12588, 1.5, 'RS', 'APS-H', 'CMOS', 'MC', 5, 10, 2020, 'A', 'eff', '@canon/canon-li8020sa-250mp-cmos-sensor/', '250MP APS-H'],
            ['canon-li8010sa', 'LI8010SA', 13272, 9176, 2.2, 'RS', 'APS-H', 'CMOS', 'MC', 9.4, 10, 2018, 'A', 'eff', '@canon/canon-120mxs-cmos-sensor/', '120MXS 120MXSM 120MXSC 120MXSI'],
            ['canon-li8030sa', 'LI8030SA', 24592, 16704, 1.5, 'RS', '35 mm full frame', 'CMOS', 'MC', 8, null, 2025, '?', 'eff', '@canon/li8030sa-410mp-ultra-high-resolution-cmos-sensor/', '410MP']
        ]],
        ['Canon', 'Ultra-high-sensitivity CMOS', [
            ['canon-35mmfhdxs', '35MMFHDXS', 2160, 1280, 19, 'RS', '35 mm full frame', 'CMOS', 'MC', 98, null, 2018, 'A', 'eff', '@canon/canon-35mmfhdxsca-19um-cmos-sensor/'],
            ['canon-li3030sa', 'LI3030SA', 2160, 1280, 19, 'RS', '35 mm full frame', 'CMOS', 'MC', 98, null, 2020, 'A', 'eff', '@canon/canon-li3030sa-19um-cmos-sensor/', 'NIR-']
        ]],
        ['OmniVision', 'OmniBSI', [
            ['ov5647', 'OV5647', 2592, 1944, 1.4, 'RS', '1/4″', 'BSI', 'C', 15, null, 2010, '?', 'act', 'https://static.sparkfun.com/datasheets/Dev/RaspberryPi/OV5647.pdf', 'OV05647-G04A']
        ]],
        ['OmniVision', 'OmniPixel3-GS', [
            ['ov7251', 'OV7251', 640, 480, 3, 'GS', '1/7.5″', 'FSI', 'M', 120, 10, null, 'EOL', 'act', '@ovt/wp-content/uploads/2022/10/OV7251-PB-v2.0-WEB.pdf', 'OV07251-A35A-1G OV07251-G04A-1G OV07251-A35A-1J OV07251-A35A'],
            ['og0ve1b', 'OG0VE1B', 640, 480, 3.006, 'GS', '1/7.5″', 'FSI', 'M', 120, null, 2022, 'A', 'act', '@ovt/products/og0ve/'],
            ['ov9281', 'OV9281', 1296, 816, 3, 'GS', '1/4″', 'FSI', 'M', 120, 10, 2017, 'A', 'act', '@ovt/products/ov9281/', 'OV09281-H64A'],
            ['ov9282', 'OV9282', 1296, 816, 3, 'GS', '1/4″', 'FSI', 'M', 120, 10, 2017, 'A', 'act', '@ovt/products/ov9282/', 'OV09282-GA4A'],
            ['og02b', 'OG02B', 1600, 1300, 3, 'GS', '1/2.9″', 'FSI', 'MC', 60, 10, 2018, 'A', 'act', '@ovt/products/og02b/', 'OG02B1B OG02B10'],
            ['ov2311', 'OV2311', 1600, 1300, 3, 'GS', '1/2.9″', 'FSI', 'M', 60, null, 2017, 'A', 'act', '@ovt/products/ov2311/', 'OV02311-E75Y-1C OV02311-E75Y-QC OV02311-E75Y-SC']
        ]],
        ['OmniVision', 'PureCel Plus-S', [
            ['og0tb1b', 'OG0TB1B', 400, 400, 2.2, 'GS', '1/14.46″', 'SBSI', 'M', 240, null, 2022, 'A', 'act', '@ovt/products/og0tb/'],
            ['og0tc1b', 'OG0TC1B', 400, 400, 2.2, 'GS', '1/14.464″', 'SBSI', 'M', 240, null, 2024, 'A', 'act', '@ovt/products/og0tc/'],
            ['og0va1b', 'OG0VA1B', 640, 480, 2.2, 'GS', '1/10.227″', 'SBSI', 'M', 240, 10, 2020, 'A', 'act', '@ovt/products/og0va/'],
            ['og01a1b', 'OG01A1B', 1280, 1024, 2.2, 'GS', '1/5″', 'SBSI', 'M', 120, null, 2019, 'A', 'act', '@ovt/products/og01a1b/'],
            ['og01h1b', 'OG01H1B', 1440, 1080, 2.2, 'GS', '1/4.545″', 'SBSI', 'M', 120, null, 2024, 'A', 'act', '@ovt/products/og01h1b/'],
            ['og02c', 'OG02C', 1632, 1264, 3.45, 'GS', '1/2.53″', 'SBSI', 'MC', 300, 8, 2024, 'A', 'act', '@ovt/products/og02c/', 'OG02C1B OG02C10'],
            ['og05b', 'OG05B', 2592, 1944, 2.2, 'GS', '1/2.53″', 'SBSI', 'MC', 60, null, 2024, 'A', 'act', '@ovt/products/og05b/', 'OG05B1B OG05B10'],
            ['og03a', 'OG03A', 2064, 1544, 3.45, 'GS', '1/1.8″', 'SBSI', 'MC', 150, 10, 2024, 'A', 'act', '@ovt/products/og03a/', 'OG03A1B OG03A10'],
            ['og05c', 'OG05C', 2464, 2064, 3.45, 'GS', '1/1.443″', 'SBSI', 'MC', 120, 10, 2024, 'A', 'act', '@ovt/products/og05c/', 'OG05C1B OG05C10'],
            ['og09a', 'OG09A', 4096, 2160, 3.45, 'GS', '1/1.002″', 'SBSI', 'MC', 60, 12, 2024, 'A', 'act', '@ovt/products/og09a/', 'OG09A1B OG09A10'],
            ['og12s', 'OG12S', 4112, 3072, 3.45, 'GS', '1/0.904″', 'SBSI', 'C', 75, 10, 2026, 'A', 'act', '@ovt/products/og12s/', 'OG12S10']
        ]],
        ['SmartSens', 'SmartGS', [
            ['sc035hgs', 'SC035HGS', 640, 480, 3.744, 'GS', '1/6″', 'BSI', 'MC', 180, null, 2020, 'A', 'rec', '@smartsens/gs_products'],
            ['sc132gs', 'SC132GS', 1080, 1280, 2.7, 'GS', '1/4″', 'SBSI', 'MC', 120, 10, 2019, 'A', 'rec', '@smartsens/gs_products'],
            ['sc130gs', 'SC130GS', 1280, 1024, 4, 'GS', '1/2.7″', 'BSI', 'MC', 240, null, 2017, 'A', 'rec', '@smartsens/gs_products']
        ]],
        ['SmartSens', 'SmartGS-2 Plus', [
            ['sc020hgs', 'SC020HGS', 400, 400, 2.2, 'GS', '1/14″', 'BSI', 'MC', 240, null, 2024, 'A', 'rec', '@smartsens/gs_products'],
            ['sc038hgs', 'SC038HGS', 640, 480, 3, 'GS', '1/7.5″', 'BSI', 'MC', 240, null, 2024, 'A', 'rec', '@smartsens/gs_products'],
            ['sc133hgs', 'SC133HGS', 1280, 960, 3, 'GS', '1/3.7″', 'BSI', 'MC', 120, null, 2023, 'A', 'rec', '@smartsens/gs_products'],
            ['sc135hgs', 'SC135HGS', 1280, 1024, 3.45, 'GS', '1/3.2″', 'BSI', 'MC', 160, null, 2023, 'A', 'rec', '@smartsens/gs_products'],
            ['sc136hgs', 'SC136HGS', 1280, 1024, 4, 'GS', '1/2.7″', 'BSI', 'MC', 240, null, 2025, 'A', 'rec', '@smartsens/gs_products'],
            ['sc233hgs', 'SC233HGS', 1920, 1200, 3, 'GS', '1/2.6″', 'BSI', 'MC', 120, null, 2023, 'A', 'rec', '@smartsens/gs_products'],
            ['sc235hgs', 'SC235HGS', 1600, 1200, 3.45, 'GS', '1/2.6″', 'BSI', 'MC', 130, 10, 2023, 'A', 'rec', '@smartsens/gs_products'],
            ['sc535hgs', 'SC535HGS', 2448, 2048, 3.45, 'GS', '2/3″', 'BSI', 'MC', 80, null, 2023, 'A', 'rec', '@smartsens/gs_products'],
            ['sc538hgs', 'SC538HGS', 2448, 2048, 3.45, 'GS', '2/3″', 'BSI', 'MC', 80, null, 2024, 'A', 'rec', '@smartsens/gs_products'],
            ['sc635hgs', 'SC635HGS', 2880, 2160, 4, 'GS', '1/1.1″', 'BSI', 'C', 65, 10, 2024, 'A', 'rec', '@smartsens/gs_products'],
            ['sc1235hgs', 'SC1235HGS', 4096, 3072, 3.45, 'GS', '1.1″', 'BSI', 'MC', 90, 10, 2025, 'A', 'rec', '@smartsens/gs_products'],
            ['sc935hgs', 'SC935HGS', 3840, 2336, 4, 'GS', '1.1″', 'BSI', 'C', 65, 10, 2024, 'A', 'rec', '@smartsens/gs_products'],
            ['sc1435hgs', 'SC1435HGS', 4480, 3072, 3.45, 'GS', '1.17″', 'BSI', 'C', 62, 10, 2025, 'A', 'rec', '@smartsens/gs_products']
        ]],
        ['SmartSens', 'SmartGS-2', [
            ['sc350hgs', 'SC350HGS', 1752, 1752, 4.2, 'GS', '2/3″', 'BSI', 'MC', 75, null, 2021, 'A', 'rec', '@smartsens/gs_products'],
            ['sc410gs', 'SC410GS', 1752, 2336, 4.2, 'GS', '1/1.3″', 'BSI', 'C', 50, null, 2020, 'A', 'rec', '@smartsens/gs_products'],
            ['sc650hgs', 'SC650HGS', 2880, 2160, 4, 'GS', '1″', 'BSI', 'MC', 65, null, 2021, 'A', 'rec', '@smartsens/gs_products'],
            ['sc910gs', 'SC910GS', 3840, 2336, 4, 'GS', '1.1″', 'BSI', 'C', 50, 10, 2020, 'A', 'rec', '@smartsens/gs_products'],
            ['sc950hgs', 'SC950HGS', 3840, 2336, 4, 'GS', '1.1″', 'BSI', 'MC', 65, null, 2021, 'A', 'rec', '@smartsens/gs_products']
        ]],
        ['STMicroelectronics', 'BrightSense', [
            ['st-vd55g0', 'VD55G0', 640, 600, 2.61, 'GS', null, 'SBSI', 'M', null, null, 2020, 'A', 'act', 'https://newsroom.st.com/media-center/press-item.html/p4234.html'],
            ['st-vd55g1', 'VD55G1', 800, 700, 2.16, 'GS', null, 'SBSI', 'M', null, null, 2023, 'A', 'act', 'https://newsroom.st.com/media-center/press-item.html/p4591.html'],
            ['st-vd56g3', 'VD56G3 / VD66GY / VD16GZ', 1124, 1364, 2.61, 'GS', null, 'SBSI', 'MC', null, null, 2020, 'A', 'act', 'https://newsroom.st.com/media-center/press-item.html/p4234.html', 'VD56G3CCA/RW VB56G3 VD66GYCCA/RW VB66GYCAGK/1 VD16GZCCA/RW V']
        ]],
        ['Fairchild Imaging', 'sCMOS', [
            ['cis1910', 'CIS1910', 1920, 1080, 6.5, 'RS', '1″', 'FSI', 'MC', 100, null, null, 'A', 'act', 'https://fairchildimaging.com/scientific-imaging'],
            ['cis2020', 'CIS2020', 2048, 2048, 6.5, 'RS', '4/3″', 'FSI', 'M', 100, null, null, 'A', 'act', 'https://fairchildimaging.com/scientific-imaging'],
            ['cis2521', 'CIS2521', 2560, 2160, 6.5, 'RS', '4/3″', 'FSI', 'MC', 100, null, null, 'A', 'act', 'https://fairchildimaging.com/scientific-imaging']
        ]],
        ['Fairchild Imaging', 'sCMOS 3.1', [
            ['hwk4123', 'HWK4123', 4100, 2300, 4.6, 'RS', '4/3″', 'BSI', 'M', 120, 11, null, 'A', 'act', 'https://fairchildimaging.com/scientific-imaging'],
            ['ltn4323', 'LTN4323', 4432, 2368, 4.6, 'RS', '4/3″', 'BSI', 'MC', 120, 11, null, 'A', 'act', 'https://fairchildimaging.com/scientific-imaging']
        ]]
    ];

    var SHUTTER = { GS: 'global', RS: 'rolling', IL: 'ccd-interline', FF: 'ccd-fullframe' };
    var TECH = { FSI: 'FSI CMOS', BSI: 'BSI CMOS', SBSI: 'stacked BSI CMOS', CMOS: 'CMOS' };
    var COLOR = { M: 'mono', C: 'color', MC: 'both' };
    var STATUS = { A: 'active', EOL: 'EOL', '?': 'unknown' };
    var BASIS = { rec: 'recommended', eff: 'effective', act: 'active' };
    // What each shutter type means for a moving part: label (prose), short (table), allAtOnce (no rolling skew)
    var shutters = {
        global: { label: 'global shutter', short: 'global', allAtOnce: true },
        rolling: { label: 'rolling shutter', short: 'rolling', allAtOnce: false },
        'ccd-interline': { label: 'interline CCD (all pixels exposed together)', short: 'CCD, interline', allAtOnce: true },
        'ccd-fullframe': { label: 'full-frame CCD (no electronic shutter)', short: 'CCD, full frame', allAtOnce: false }
    };

    var sensors = [];
    G.forEach(function (g) {
        g[2].forEach(function (r) {
            var w = r[2] * r[4] / 1000, h = r[3] * r[4] / 1000;   // mm
            var shutter = SHUTTER[r[5]];
            var s = {
                id: r[0], maker: g[0], family: g[1], name: r[1], nx: r[2], ny: r[3], pitch: r[4],
                shutter: shutter, format: r[6], width: w, height: h, diag: Math.hypot(w, h), mp: r[2] * r[3] / 1e6,
                tech: r[7] === 'CCD' ? (shutter === 'ccd-fullframe' ? 'full-frame CCD' : 'interline CCD') : TECH[r[7]],
                color: COLOR[r[8]], fps: r[9], fpsBits: r[10], year: r[11], status: STATUS[r[12]], basis: BASIS[r[13]],
                src: r[14].replace(/^@(\w+)\//, function (m, k) { return URLS[k]; }), alt: r[15] || '',
                frameReadout: /frame readout/.test(g[1])
            };
            s.allAtOnce = shutters[shutter].allAtOnce && !s.frameReadout;
            // search text: every word a reader may type (part number, maker, series, format, shutter, technology, status)
            s.search = [s.id, s.name, s.alt, s.maker, s.family, s.format || '', shutter, shutters[shutter].short, s.tech,
                s.color === 'both' ? 'mono color' : s.color, s.status === 'EOL' ? 'eol discontinued' : '', s.nx + 'x' + s.ny]
                .join(' ').toLowerCase().replace(/″/g, '');
            sensors.push(s);
        });
    });

    // Typical sustained image payload, MB/s (10^6 bytes/s). Ethernet, USB3, and CoaXPress: after protocol overhead
    // (GigE family per JAI; USB3 Vision 350–400 MB/s per A3; CoaXPress: 8b/10b-coded 6.25 and 12.5 Gb/s links,
    // about 95 % usable). Camera Link: the 85 MHz maximum (Base 2.04 Gb/s, Full 5.44 Gb/s).
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

    // Bytes per pixel on the wire for common GenICam pixel formats (PFNC 2.4: "p" = packed, no padding bits).
    var pixelFormats = [
        { id: 'mono8',  name: 'Mono8 / Bayer8',      bpp: 1 },
        { id: 'mono10', name: 'Mono10p / Bayer10p',  bpp: 1.25 },
        { id: 'mono12', name: 'Mono12p / Bayer12p',  bpp: 1.5 },
        { id: 'rgb8',   name: 'RGB8 (debayered)',    bpp: 3 }
    ];

    // Lens formats by image-circle diameter (mm), smallest first: Edmund Optics' sensor-format table and Sony's type
    // designations (1.2″ = 19.3 mm, APS-C = 27.9 mm); APS-H (35 mm) and its TFL-II (M48) mount per Edmund Optics'
    // "Lens Mounts" note; mounts per JIIA LER-004 and lens makers' practice. No standard format is listed above
    // 35 mm full frame: lensFormatFor returns a "custom" entry for a larger sensor rather than claim coverage.
    var lensFormats = [
        { name: '1/2″',  circle: 8.0,  mount: 'C-mount or CS-mount' },
        { name: '1/1.8″', circle: 9.0, mount: 'C-mount' },
        { name: '2/3″',  circle: 11.0, mount: 'C-mount' },
        { name: '1″',    circle: 16.0, mount: 'C-mount' },
        { name: '1.1″',  circle: 17.6, mount: 'C-mount' },
        { name: '1.2″',  circle: 19.3, mount: 'C-mount (1.2″-rated lenses only)' },
        { name: '4/3″',  circle: 21.6, mount: 'TFL (M35) or M42' },
        { name: 'APS-C', circle: 27.9, mount: 'TFL (M35), TFL-II (M48), or M42' },
        { name: 'APS-H', circle: 35.0, mount: 'TFL-II (M48)' },
        { name: '35 mm full frame', circle: 43.3, mount: 'F-mount, M58, or M72' }
    ];
    var customFormat = { name: null, circle: null, custom: true, mount: 'M72 or a larger mount, often with a custom lens' };

    var focalLengths = [4, 5, 6, 8, 12, 16, 25, 35, 50, 75, 100];

    var lighting = {
        measure: {
            label: 'Dimensional gauging (edges, holes, profiles)',
            light: 'Backlight for a sharp silhouette. Use a telecentric lens with a collimated or telecentric backlight when part height varies or accuracy matters.',
            color: 'Monochrome camera. Blue or green light gives a smaller diffraction blur, and so sharper edges, than red.'
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

    // Old ids that were renamed resolve to the current row (share links store ids). None so far: every id kept.
    var aliases = {};
    var byId = {};
    sensors.forEach(function (s) { byId[s.id] = s; });
    function sensorById(id) { return byId[id] || byId[aliases[id]] || null; }
    function formatLabel(s) { return s.format || ('Ø ' + s.diag.toFixed(1) + ' mm'); }
    // The format in a sentence: "Type 2/3" for an inch type, the name itself otherwise ("APS-C", "Super 35 mm")
    function formatPhrase(s) { return !s.format ? '' : /″$/.test(s.format) ? 'Type ' + s.format.replace('″', '') : s.format; }
    function lensFormatFor(diag) {
        for (var i = 0; i < lensFormats.length; i++) if (lensFormats[i].circle >= diag - 0.15) return lensFormats[i];   // 2/3″ lenses cover an 11.05 mm diagonal
        return customFormat;
    }
    function shutterLabel(s) { return s.frameReadout ? 'interline CCD with frame readout' : shutters[s.shutter].label; }
    function esc(t) { return String(t).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
    function optionLabel(s) {
        return s.name + ' · ' + formatLabel(s) + ' · ' + s.nx + ' × ' + s.ny + ' · ' + s.pitch + ' µm' +
            (s.shutter === 'global' ? '' : ' · ' + shutters[s.shutter].short) + (s.status === 'EOL' ? ' · EOL' : '');
    }
    // <select> options grouped by maker and series, in data order (makers by size, series by family, then sensor size)
    function sensorOptionsHTML(selectedId, list) {
        var out = '', cur = null;
        (list || sensors).forEach(function (s) {
            var g = s.maker + ' · ' + s.family;
            if (g !== cur) { out += (cur ? '</optgroup>' : '') + '<optgroup label="' + esc(g) + '">'; cur = g; }
            out += '<option value="' + s.id + '"' + (s.id === selectedId ? ' selected' : '') + '>' + esc(optionLabel(s)) + '</option>';
        });
        return out + (cur ? '</optgroup>' : '');
    }
    // Every word of the query must appear in the sensor's search text; a full part number ("IMX250LLR") also
    // matches the sensor whose id it starts with.
    function matchSensors(query) {
        var words = String(query).toLowerCase().replace(/″/g, '').split(/[\s,]+/).filter(Boolean);
        return sensors.filter(function (s) {
            return words.every(function (w) {
                return s.search.indexOf(w) >= 0 || (w.length > s.id.length && w.indexOf(s.id) === 0);
            });
        });
    }
    // One line about the chosen sensor: series, shutter, technology, color, speed, year, status, array basis, source
    function sensorInfoHTML(s) {
        if (!s) return 'Enter the pixel pitch and pixel counts from the camera datasheet.';
        var bits = [esc(s.maker + ' ' + s.family), esc(shutterLabel(s))];
        if (!/CCD/.test(s.tech)) bits.push(esc(s.tech));   // a CCD's shutter label already names it
        bits.push(s.color === 'both' ? 'mono and color versions' : s.color === 'mono' ? 'mono only' : 'color only');
        if (s.fps) bits.push('up to ' + s.fps + '&nbsp;fps at full resolution' + (s.fpsBits ? ' (' + s.fpsBits + '-bit)' : ''));
        if (s.year) bits.push(String(s.year));
        bits.push(s.status === 'active' ? 'in production' : s.status === 'EOL' ? '<b>discontinued (EOL)</b>' : 'production status not stated');
        bits.push(s.basis === 'recommended' ? 'array: the maker’s recommended size' : 'array: the maker’s ' + s.basis + ' array');
        bits.push('<a href="' + esc(s.src) + '" target="_blank" rel="noopener" aria-label="Source for ' + esc(s.name) + '">source</a>');
        return bits.join(' · ');
    }

    // Searchable sensor picker: a search box above the native grouped <select> (keyboard and screen-reader friendly),
    // a live match count, and an info line. The <select> keeps its name, so share links and Calc state are unchanged.
    // opts: { selected: id, custom: true to keep a "Custom" option first }. Returns { refresh(), choose(id) }.
    function attachPicker(select, opts) {
        opts = opts || {};
        var id = select.id, total = sensors.length;
        var head = opts.custom ? '<option value="custom">Custom</option>' : '';
        var q = document.createElement('input');
        q.type = 'search'; q.className = 'input'; q.id = id + '-q'; q.autocomplete = 'off'; q.spellcheck = false;
        q.placeholder = 'Search: IMX547, Pregius S, onsemi, 2/3, rolling…';
        q.setAttribute('aria-label', 'Search the ' + total + ' sensors');
        q.setAttribute('aria-controls', id);
        q.setAttribute('aria-describedby', id + '-n');
        q.style.marginBottom = '0.45rem';
        var n = document.createElement('p');
        n.className = 'hint'; n.id = id + '-n'; n.setAttribute('aria-live', 'polite'); n.hidden = true;
        var info = document.createElement('p');
        info.className = 'hint'; info.id = id + '-info';
        select.parentNode.insertBefore(q, select);
        select.parentNode.insertBefore(n, select.nextSibling);
        select.parentNode.insertBefore(info, n.nextSibling);
        select.setAttribute('aria-describedby', info.id);
        select.innerHTML = head + sensorOptionsHTML(opts.selected);

        function fill(list) {
            var v = select.value, cur = sensorById(v);
            if (cur && list.indexOf(cur) < 0) list = sensors.filter(function (s) { return s === cur || list.indexOf(s) >= 0; });
            select.innerHTML = head + sensorOptionsHTML(v, list);
            select.value = v;
        }
        function update() {
            var t = q.value.trim(), list = t ? matchSensors(t) : sensors;
            fill(list);
            n.hidden = !t;
            n.textContent = !t ? '' : list.length ? list.length + ' of ' + total + ' sensors match. Choose one in the list below, or press Enter for the first.'
                : 'No sensor matches “' + t + '”.';
        }
        function refresh() { info.innerHTML = sensorInfoHTML(sensorById(select.value)); }
        function choose(sid) {
            if (!sensorById(sid)) return;
            if (!select.querySelector('option[value="' + sid + '"]')) { q.value = ''; update(); }
            select.value = sid;
            select.dispatchEvent(new Event('change', { bubbles: true }));
        }
        // the search box is not a calculator input: keep its events away from the form's listeners
        q.addEventListener('input', function (e) { e.stopPropagation(); update(); });
        q.addEventListener('change', function (e) { e.stopPropagation(); });
        q.addEventListener('keydown', function (e) {
            if (e.key === 'Enter') {
                e.preventDefault();
                var first = q.value.trim() && matchSensors(q.value)[0];
                if (first && first.id !== select.value) choose(first.id);
            } else if (e.key === 'ArrowDown' && !e.altKey) { e.preventDefault(); select.focus(); }
            else if (e.key === 'Escape' && q.value) { e.preventDefault(); q.value = ''; update(); }
        });
        select.addEventListener('change', refresh);
        // Reset restores the default sensor, which must be in the list: clear the search first (capture phase runs
        // before the button's own handler)
        document.addEventListener('click', function (e) {
            if (q.value && e.target.closest && e.target.closest('[data-action="reset"]')) { q.value = ''; update(); }
        }, true);
        refresh();
        return { refresh: refresh, choose: choose };
    }

    window.VisionData = {
        sensors: sensors, interfaces: interfaces, pixelFormats: pixelFormats, lensFormats: lensFormats,
        focalLengths: focalLengths, lighting: lighting, shutters: shutters, aliases: aliases,
        makers: sensors.reduce(function (a, s) { if (a.indexOf(s.maker) < 0) a.push(s.maker); return a; }, []),
        sensorById: sensorById, formatLabel: formatLabel, formatPhrase: formatPhrase, lensFormatFor: lensFormatFor,
        shutterLabel: shutterLabel, sensorOptionsHTML: sensorOptionsHTML, matchSensors: matchSensors,
        sensorInfoHTML: sensorInfoHTML, attachPicker: attachPicker
    };
})();
