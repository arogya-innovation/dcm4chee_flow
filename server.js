const express = require('express');
const fetch = require('node-fetch');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const crypto = require('crypto');
const https = require('https');
const PDFDocument = require('pdfkit');

const REPORTS_DIR = path.join(__dirname, 'reports');
if (!fs.existsSync(REPORTS_DIR)) fs.mkdirSync(REPORTS_DIR);

const app = express();
const PORT = 3080;

const DCM4CHEE_BASE = 'http://178.236.185.39:8085';
const AE_TITLE = 'DCM4CHEE';
const MWL_AE_TITLE = 'WORKLIST';

// ─── OpenMRS / Bahmni Configuration ───
const OPENMRS_BASE = process.env.OPENMRS_BASE || 'https://178.236.185.39/openmrs';
const OPENMRS_USER = process.env.OPENMRS_USER || 'superman';
const OPENMRS_PASS = process.env.OPENMRS_PASS || 'Admin123';
const OPENMRS_AUTH = 'Basic ' + Buffer.from(`${OPENMRS_USER}:${OPENMRS_PASS}`).toString('base64');
const BAHMNI_LOCATION_UUID = process.env.BAHMNI_LOCATION_UUID || 'b5da9afd-b29a-4cbf-91c9-ccf2aa5f799e';
const BAHMNI_PROVIDER_UUID = process.env.BAHMNI_PROVIDER_UUID || 'd7a67c17-5e07-11ef-8f7c-0242ac120002';

// Bahmni Concept UUIDs
const CONCEPT_RADIOLOGY_FORM = '2e820990-e709-4c57-bfa2-ba71b66bd717';
const CONCEPT_SUMMARY = 'cf1844e6-d734-4e24-8a26-1f48f8e54ebb';
const CONCEPT_RADIOLOGY_NOTES = 'ae6e5490-ade9-486e-8268-9e4efd45b07e';
const CONCEPT_DIAGNOSTIC_IMAGES = '4e7ac8d1-38fa-461c-8b3a-aa66049369ba';

const httpsAgent = new https.Agent({ rejectUnauthorized: false });

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 500 * 1024 * 1024 } });

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ─── CREATE MWL ORDER (Step 1: create patient, Step 2: create MWL item) ───
app.post('/api/mwl', async (req, res) => {
  try {
    const dicom = req.body;

    const patientJson = {};
    const patientTags = ['00100010', '00100020', '00100030', '00100040'];
    for (const tag of patientTags) {
      if (dicom[tag]) patientJson[tag] = dicom[tag];
    }

    const patientUrl = `${DCM4CHEE_BASE}/dcm4chee-arc/aets/${AE_TITLE}/rs/patients`;
    const patientRes = await fetch(patientUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/dicom+json' },
      body: JSON.stringify(patientJson),
    });

    if (!patientRes.ok && patientRes.status !== 409) {
      const errText = await patientRes.text();
      console.error('Patient creation error:', patientRes.status, errText);
      return res.status(patientRes.status).json({ error: 'Failed to create patient: ' + (errText || patientRes.statusText) });
    }
    console.log('Patient created/exists, status:', patientRes.status);

    const mwlUrl = `${DCM4CHEE_BASE}/dcm4chee-arc/aets/${MWL_AE_TITLE}/rs/mwlitems`;
    const mwlRes = await fetch(mwlUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/dicom+json' },
      body: JSON.stringify(dicom),
    });

    if (mwlRes.ok) {
      let data;
      const text = await mwlRes.text();
      try { data = JSON.parse(text); } catch { data = { message: text || 'MWL item created successfully' }; }
      res.status(mwlRes.status).json(data);
    } else {
      const errText = await mwlRes.text();
      console.error('MWL creation error:', mwlRes.status, errText);
      res.status(mwlRes.status).json({ error: errText || mwlRes.statusText });
    }
  } catch (err) {
    console.error('Proxy error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── LIST MWL ORDERS ───
app.get('/api/mwl', async (req, res) => {
  const url = `${DCM4CHEE_BASE}/dcm4chee-arc/aets/${MWL_AE_TITLE}/rs/mwlitems?includefield=all&limit=200`;
  try {
    const response = await fetch(url, { headers: { 'Accept': 'application/dicom+json' } });
    if (response.ok) {
      const data = await response.json();
      res.json(data);
    } else if (response.status === 204) {
      res.json([]);
    } else {
      const errText = await response.text();
      res.status(response.status).json({ error: errText || response.statusText });
    }
  } catch (err) {
    console.error('List MWL error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── LIST STUDIES ───
app.get('/api/studies', async (req, res) => {
  const url = `${DCM4CHEE_BASE}/dcm4chee-arc/aets/${AE_TITLE}/rs/studies?includefield=all&limit=200`;
  try {
    const response = await fetch(url, { headers: { 'Accept': 'application/dicom+json' } });
    if (response.ok) {
      const data = await response.json();
      res.json(data);
    } else if (response.status === 204) {
      res.json([]);
    } else {
      const errText = await response.text();
      res.status(response.status).json({ error: errText || response.statusText });
    }
  } catch (err) {
    console.error('List studies error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── UPLOAD DICOM FILES VIA STOW-RS ───
app.post('/api/upload', upload.array('dicomFiles', 100), async (req, res) => {
  if (!req.files || req.files.length === 0) {
    return res.status(400).json({ error: 'No DICOM files provided' });
  }

  const studyUID = req.body.studyInstanceUID || '';
  const stowUrl = studyUID
    ? `${DCM4CHEE_BASE}/dcm4chee-arc/aets/${AE_TITLE}/rs/studies/${studyUID}`
    : `${DCM4CHEE_BASE}/dcm4chee-arc/aets/${AE_TITLE}/rs/studies`;

  const boundary = '----DicomBoundary' + crypto.randomBytes(16).toString('hex');

  // Build multipart/related body
  const parts = [];
  for (const file of req.files) {
    parts.push(Buffer.from(
      `\r\n--${boundary}\r\nContent-Type: application/dicom\r\n\r\n`
    ));
    parts.push(file.buffer);
  }
  parts.push(Buffer.from(`\r\n--${boundary}--\r\n`));

  const body = Buffer.concat(parts);

  try {
    console.log(`STOW-RS: uploading ${req.files.length} file(s) to ${stowUrl}`);
    const response = await fetch(stowUrl, {
      method: 'POST',
      headers: {
        'Content-Type': `multipart/related; type="application/dicom"; boundary=${boundary}`,
        'Accept': 'application/dicom+json',
      },
      body: body,
    });

    const text = await response.text();
    if (response.ok) {
      let data;
      try { data = JSON.parse(text); } catch { data = { message: 'Upload successful' }; }
      console.log('STOW-RS success:', response.status);
      res.status(response.status).json(data);
    } else {
      console.error('STOW-RS error:', response.status, text);
      res.status(response.status).json({ error: text || response.statusText });
    }
  } catch (err) {
    console.error('Upload error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── BUILD MINIMAL DICOM FILE FROM ORDER DATA ───
function buildDicomFile(opts) {
  // opts: patientName, patientId, dob, sex, studyUid, accession, modality, studyDate, studyDesc, seriesUid, sopUid
  function genUID() { return '1.2.826.0.1.3680043.8.498.' + Date.now() + '.' + Math.floor(Math.random() * 1e10); }
  const seriesUid = opts.seriesUid || genUID();
  const sopUid = opts.sopUid || genUID();
  const sopClassUid = '1.2.840.10008.5.1.4.1.1.7'; // Secondary Capture
  const transferSyntax = '1.2.840.10008.1.2.1'; // Explicit VR Little Endian
  const implClassUid = '1.2.826.0.1.3680043.8.498.1';
  const now = new Date();
  const dateStr = opts.studyDate || (now.getFullYear().toString() + String(now.getMonth()+1).padStart(2,'0') + String(now.getDate()).padStart(2,'0'));
  const timeStr = String(now.getHours()).padStart(2,'0') + String(now.getMinutes()).padStart(2,'0') + String(now.getSeconds()).padStart(2,'0');

  // Helper: write a DICOM element in Explicit VR Little Endian
  const elements = [];
  function addElem(group, elem, vr, value) {
    const valBuf = Buffer.from(value, 'utf-8');
    let padded = valBuf;
    if (valBuf.length % 2 !== 0) {
      // Pad with space (0x20) for most VRs, null (0x00) for UI
      const padByte = (vr === 'UI') ? 0x00 : 0x20;
      padded = Buffer.concat([valBuf, Buffer.from([padByte])]);
    }
    const header = Buffer.alloc(8);
    header.writeUInt16LE(group, 0);
    header.writeUInt16LE(elem, 2);
    header.write(vr, 4, 2, 'ascii');
    header.writeUInt16LE(padded.length, 6);
    elements.push(Buffer.concat([header, padded]));
  }

  // File Meta Information
  const metaElems = [];
  function addMeta(group, elem, vr, value) {
    const valBuf = Buffer.from(value, 'utf-8');
    let padded = valBuf;
    if (valBuf.length % 2 !== 0) {
      const padByte = (vr === 'UI') ? 0x00 : 0x20;
      padded = Buffer.concat([valBuf, Buffer.from([padByte])]);
    }
    const header = Buffer.alloc(8);
    header.writeUInt16LE(group, 0);
    header.writeUInt16LE(elem, 2);
    header.write(vr, 4, 2, 'ascii');
    header.writeUInt16LE(padded.length, 6);
    metaElems.push(Buffer.concat([header, padded]));
  }

  // (0002,0001) File Meta Information Version — OB VR uses long format: tag(4)+VR(2)+reserved(2)+len(4)+val
  const fmiVersion = Buffer.alloc(8);
  fmiVersion.writeUInt16LE(0x0002, 0); fmiVersion.writeUInt16LE(0x0001, 2);
  fmiVersion.write('OB', 4, 2, 'ascii');
  // bytes 6-7 are reserved (already 0 from alloc)
  const fmiVersionLen = Buffer.alloc(4); fmiVersionLen.writeUInt32LE(2, 0);
  const fmiVersionVal = Buffer.from([0x00, 0x01]);
  metaElems.push(Buffer.concat([fmiVersion, fmiVersionLen, fmiVersionVal]));

  addMeta(0x0002, 0x0002, 'UI', sopClassUid);       // Media Storage SOP Class UID
  addMeta(0x0002, 0x0003, 'UI', sopUid);             // Media Storage SOP Instance UID
  addMeta(0x0002, 0x0010, 'UI', transferSyntax);     // Transfer Syntax UID
  addMeta(0x0002, 0x0012, 'UI', implClassUid);       // Implementation Class UID

  // Calculate group length
  const metaBody = Buffer.concat(metaElems);
  const grpLenHeader = Buffer.alloc(12);
  grpLenHeader.writeUInt16LE(0x0002, 0); grpLenHeader.writeUInt16LE(0x0000, 2);
  grpLenHeader.write('UL', 4, 2, 'ascii'); grpLenHeader.writeUInt16LE(4, 6);
  grpLenHeader.writeUInt32LE(metaBody.length, 8);

  // Dataset elements (sorted by tag)
  addElem(0x0008, 0x0016, 'UI', sopClassUid);                  // SOP Class UID
  addElem(0x0008, 0x0018, 'UI', sopUid);                       // SOP Instance UID
  addElem(0x0008, 0x0020, 'DA', dateStr);                      // Study Date
  addElem(0x0008, 0x0030, 'TM', timeStr);                      // Study Time
  addElem(0x0008, 0x0050, 'SH', opts.accession || '');         // Accession Number
  addElem(0x0008, 0x0060, 'CS', opts.modality || 'OT');        // Modality
  addElem(0x0008, 0x0064, 'CS', 'WSD');                        // Conversion Type
  addElem(0x0008, 0x1030, 'LO', opts.studyDesc || '');         // Study Description
  addElem(0x0010, 0x0010, 'PN', opts.patientName || '');       // Patient Name
  addElem(0x0010, 0x0020, 'LO', opts.patientId || '');         // Patient ID
  addElem(0x0010, 0x0030, 'DA', opts.dob || '');               // Patient DOB
  addElem(0x0010, 0x0040, 'CS', opts.sex || '');               // Patient Sex
  addElem(0x0020, 0x000D, 'UI', opts.studyUid);                // Study Instance UID
  addElem(0x0020, 0x000E, 'UI', seriesUid);                    // Series Instance UID
  addElem(0x0020, 0x0010, 'SH', opts.accession || '');         // Study ID
  addElem(0x0020, 0x0011, 'IS', '1');                          // Series Number
  addElem(0x0020, 0x0013, 'IS', '1');                          // Instance Number

  // Minimal 1x1 pixel data for a valid SC image
  addElem(0x0028, 0x0002, 'US', '');  // placeholder, will fix below
  addElem(0x0028, 0x0004, 'CS', 'MONOCHROME2');
  addElem(0x0028, 0x0010, 'US', '');  // Rows placeholder
  addElem(0x0028, 0x0011, 'US', '');  // Columns placeholder
  addElem(0x0028, 0x0100, 'US', '');  // Bits Allocated
  addElem(0x0028, 0x0101, 'US', '');  // Bits Stored
  addElem(0x0028, 0x0102, 'US', '');  // High Bit

  // Remove placeholder US elements, re-add as proper binary US
  // Actually let me rebuild the image attributes properly
  elements.splice(-7); // remove the 7 placeholder image elements

  // Add proper US (unsigned short) elements for image attributes
  function addUS(group, elem, value) {
    const buf = Buffer.alloc(10);
    buf.writeUInt16LE(group, 0); buf.writeUInt16LE(elem, 2);
    buf.write('US', 4, 2, 'ascii'); buf.writeUInt16LE(2, 6);
    buf.writeUInt16LE(value, 8);
    elements.push(buf);
  }

  addUS(0x0028, 0x0002, 1);    // Samples Per Pixel
  addElem(0x0028, 0x0004, 'CS', 'MONOCHROME2'); // Photometric Interpretation
  addUS(0x0028, 0x0010, 1);    // Rows
  addUS(0x0028, 0x0011, 1);    // Columns
  addUS(0x0028, 0x0100, 8);    // Bits Allocated
  addUS(0x0028, 0x0101, 8);    // Bits Stored
  addUS(0x0028, 0x0102, 7);    // High Bit
  addUS(0x0028, 0x0103, 0);    // Pixel Representation

  // Pixel Data (7FE0,0010) — OW VR uses long format: tag(4)+VR(2)+reserved(2)+len(4)+val
  const pixHeader = Buffer.alloc(8);
  pixHeader.writeUInt16LE(0x7FE0, 0); pixHeader.writeUInt16LE(0x0010, 2);
  pixHeader.write('OW', 4, 2, 'ascii');
  // bytes 6-7 are reserved (already 0 from alloc)
  const pixLen = Buffer.alloc(4); pixLen.writeUInt32LE(2, 0); // 2 bytes (1x1 pixel padded to even)
  const pixData = Buffer.from([0x00, 0x00]); // black 1x1 pixel
  elements.push(Buffer.concat([pixHeader, pixLen, pixData]));

  const dataset = Buffer.concat(elements);

  // 128-byte preamble + DICM
  const preamble = Buffer.alloc(128, 0);
  const magic = Buffer.from('DICM', 'ascii');

  return Buffer.concat([preamble, magic, grpLenHeader, metaBody, dataset]);
}

// Helper: extract value from DICOM JSON
function djv(obj, tag) {
  if (!obj || !obj[tag] || !obj[tag].Value) return '';
  const v = obj[tag].Value[0];
  if (typeof v === 'object' && v.Alphabetic) return v.Alphabetic;
  return String(v);
}

// ─── CREATE DICOM FROM MWL ORDER & UPLOAD TO PACS ───
app.post('/api/create-dicom-from-order', async (req, res) => {
  try {
    const order = req.body;
    const sps = (order['00400100'] && order['00400100'].Value && order['00400100'].Value[0]) || {};

    const studyUid = djv(order, '0020000D');
    if (!studyUid) return res.status(400).json({ error: 'Order has no Study Instance UID' });

    const dicomBuf = buildDicomFile({
      patientName: djv(order, '00100010'),
      patientId:   djv(order, '00100020'),
      dob:         djv(order, '00100030'),
      sex:         djv(order, '00100040'),
      studyUid:    studyUid,
      accession:   djv(order, '00080050'),
      modality:    djv(sps, '00080060') || 'OT',
      studyDate:   djv(sps, '00400002'),
      studyDesc:   djv(order, '00321060'),
    });

    // Upload via STOW-RS
    const stowUrl = `${DCM4CHEE_BASE}/dcm4chee-arc/aets/${AE_TITLE}/rs/studies`;
    const boundary = '----DicomBoundary' + crypto.randomBytes(16).toString('hex');
    const body = Buffer.concat([
      Buffer.from(`\r\n--${boundary}\r\nContent-Type: application/dicom\r\n\r\n`),
      dicomBuf,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);

    console.log(`Creating DICOM for order ${djv(order, '00080050')} -> Study UID ${studyUid}`);
    const stowRes = await fetch(stowUrl, {
      method: 'POST',
      headers: {
        'Content-Type': `multipart/related; type="application/dicom"; boundary=${boundary}`,
        'Accept': 'application/dicom+json',
      },
      body: body,
    });

    const text = await stowRes.text();
    if (stowRes.ok) {
      let data;
      try { data = JSON.parse(text); } catch { data = { message: 'DICOM created and uploaded' }; }
      console.log('DICOM created & uploaded:', stowRes.status);
      res.json({ message: 'DICOM file created and uploaded to PACS', studyUid, details: data });
    } else {
      console.error('STOW-RS error for created DICOM:', stowRes.status, text);
      res.status(stowRes.status).json({ error: text || stowRes.statusText });
    }
  } catch (err) {
    console.error('Create DICOM error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── SAVE REPORT ───
app.post('/api/reports', (req, res) => {
  try {
    const report = req.body;
    report.reportId = report.reportId || 'RPT-' + Date.now().toString(36).toUpperCase();
    report.createdAt = new Date().toISOString();
    const filename = report.reportId + '.json';
    fs.writeFileSync(path.join(REPORTS_DIR, filename), JSON.stringify(report, null, 2));
    console.log('Report saved:', report.reportId);
    res.json({ message: 'Report saved successfully', reportId: report.reportId });
  } catch (err) {
    console.error('Save report error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── LIST REPORTS ───
app.get('/api/reports', (req, res) => {
  try {
    const files = fs.readdirSync(REPORTS_DIR).filter(f => f.endsWith('.json'));
    const reports = files.map(f => {
      const data = JSON.parse(fs.readFileSync(path.join(REPORTS_DIR, f), 'utf-8'));
      return data;
    }).sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
    res.json(reports);
  } catch (err) {
    console.error('List reports error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── GET SINGLE REPORT ───
app.get('/api/reports/:id', (req, res) => {
  try {
    const filepath = path.join(REPORTS_DIR, req.params.id + '.json');
    if (!fs.existsSync(filepath)) return res.status(404).json({ error: 'Report not found' });
    const data = JSON.parse(fs.readFileSync(filepath, 'utf-8'));
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── GENERATE RADIOLOGY REPORT PDF ───
// function generateReportPDF(report) {
//   return new Promise((resolve, reject) => {
//     const doc = new PDFDocument({ margin: 50 });
//     const chunks = [];
//     doc.on('data', chunk => chunks.push(chunk));
//     doc.on('end', () => resolve(Buffer.concat(chunks)));
//     doc.on('error', reject);

//     // Header
//     doc.fontSize(20).font('Helvetica-Bold').fillColor('#3B4899')
//        .text('LifeRhythem', { align: 'center' });
//     doc.fontSize(9).font('Helvetica-Oblique').fillColor('#7B82B5')
//        .text('Citizen Wellness is our Priority', { align: 'center' });
//     doc.moveDown(0.5);
//     doc.fontSize(14).font('Helvetica-Bold').fillColor('#3B4899')
//        .text('RADIOLOGY REPORT', { align: 'center' });
//     doc.moveDown(0.5);
//     doc.strokeColor('#3B4899').lineWidth(2)
//        .moveTo(50, doc.y).lineTo(545, doc.y).stroke();
//     doc.moveDown(0.5);

//     // Patient info grid
//     const infoY = doc.y;
//     const col1 = 50, col2 = 220, col3 = 390;
//     function infoRow(y, label1, val1, label2, val2, label3, val3) {
//       doc.font('Helvetica-Bold').fontSize(8).fillColor('#3B4899');
//       doc.text(label1, col1, y);
//       if (label2) doc.text(label2, col2, y);
//       if (label3) doc.text(label3, col3, y);
//       doc.font('Helvetica').fontSize(9).fillColor('#1a1a2e');
//       doc.text(val1 || '-', col1, y + 11);
//       if (label2) doc.text(val2 || '-', col2, y + 11);
//       if (label3) doc.text(val3 || '-', col3, y + 11);
//     }
//     infoRow(infoY, 'PATIENT NAME', report.patientName, 'PATIENT ID', report.patientId, 'DOB', report.dob);
//     infoRow(infoY + 30, 'SEX', report.sex, 'ACCESSION #', report.accessionNumber, 'MODALITY', report.modality);
//     infoRow(infoY + 60, 'STUDY DATE', report.studyDate, 'PROCEDURE', report.procedure, 'REFERRING PHYSICIAN', report.referringPhysician);
//     doc.y = infoY + 95;
//     doc.strokeColor('#e8ecf1').lineWidth(1)
//        .moveTo(50, doc.y).lineTo(545, doc.y).stroke();
//     doc.moveDown(0.8);

//     // Report sections
//     function section(title, content) {
//       if (!content) return;
//       doc.font('Helvetica-Bold').fontSize(11).fillColor('#3B4899').text(title);
//       doc.moveDown(0.3);
//       doc.font('Helvetica').fontSize(10).fillColor('#1a1a2e').text(content, { lineGap: 3 });
//       doc.moveDown(0.8);
//     }
//     section('Clinical History', report.clinicalHistory);
//     section('Technique', report.technique);
//     section('Findings', report.findings);
//     section('Impression / Conclusion', report.impression);
//     section('Recommendation', report.recommendation);

//     // Signature area
//     doc.moveDown(2);
//     doc.font('Helvetica').fontSize(9).fillColor('#718096')
//        .text('Report Date: ' + (report.reportDate || new Date().toISOString().split('T')[0]), 50);
//     doc.moveDown(2);
//     doc.strokeColor('#1a1a2e').lineWidth(0.5)
//        .moveTo(350, doc.y).lineTo(545, doc.y).stroke();
//     doc.moveDown(0.3);
//     doc.font('Helvetica-Bold').fontSize(10).fillColor('#1a1a2e')
//        .text(report.radiologist || '', 350, doc.y, { width: 195, align: 'center' });
//     doc.font('Helvetica').fontSize(8).fillColor('#718096')
//        .text('Reporting Radiologist', 350, doc.y, { width: 195, align: 'center' });

//     doc.end();
//   });
// }




// ─── GENERATE RADIOLOGY REPORT PDF (Enhanced Formatting) ───
function generateReportPDF(report) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ 
      margin: 50,
      size: 'A4',
      layout: 'portrait'
    });
    const chunks = [];
    doc.on('data', chunk => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    // ─── HEADER SECTION ───
    // Top border accent
    doc.rect(0, 0, doc.page.width, 8).fill('#3B4899');
    
    // Logo area (if you have a logo image)
    // doc.image('logo.png', 50, 20, { width: 80 });
    
    // Title
    doc.fontSize(24).font('Helvetica-Bold').fillColor('#3B4899')
       .text('LifeRhythem', { align: 'center' });
    doc.fontSize(10).font('Helvetica-Oblique').fillColor('#7B82B5')
       .text('Citizen Wellness is our Priority', { align: 'center' });
    doc.moveDown(0.8);
    
    // Report Title with underline
    doc.fontSize(18).font('Helvetica-Bold').fillColor('#2C3E66')
       .text('RADIOLOGY REPORT', { align: 'center' });
    doc.moveDown(0.3);
    
    // Decorative line
    doc.strokeColor('#3B4899').lineWidth(1.5)
       .moveTo(150, doc.y).lineTo(doc.page.width - 150, doc.y).stroke();
    doc.moveDown(1);

    // ─── PATIENT INFORMATION CARD ───
    const cardY = doc.y;
    
    // Background for patient info
    doc.rect(45, cardY - 5, doc.page.width - 90, 95)
       .fillAndStroke('#F8F9FC', '#E4E7F0');
    
    // Patient Info Header
    doc.fontSize(11).font('Helvetica-Bold').fillColor('#3B4899')
       .text('PATIENT INFORMATION', 50, cardY);
    doc.moveDown(0.8);
    
    // Two-column layout for patient info
    const leftCol = 50;
    const rightCol = 320;
    let currentY = doc.y;
    
    function addInfoRow(label, value, x, y) {
      doc.font('Helvetica-Bold').fontSize(9).fillColor('#4A5568')
         .text(label + ':', x, y);
      doc.font('Helvetica').fontSize(10).fillColor('#1A202C')
         .text(value || '—', x + 85, y);
    }
    
    // Left column
    addInfoRow('Patient Name', report.patientName, leftCol, currentY);
    addInfoRow('Patient ID', report.patientId, leftCol, currentY + 20);
    addInfoRow('Date of Birth', report.dob, leftCol, currentY + 40);
    addInfoRow('Sex', report.sex, leftCol, currentY + 60);
    
    // Right column
    addInfoRow('Accession #', report.accessionNumber, rightCol, currentY);
    addInfoRow('Modality', report.modality, rightCol, currentY + 20);
    addInfoRow('Study Date', report.studyDate || '—', rightCol, currentY + 40);
    addInfoRow('Referring Physician', report.referringPhysician || '—', rightCol, currentY + 60);
    
    doc.y = currentY + 85;
    doc.moveDown(0.5);

    // ─── STUDY DETAILS (if procedure exists) ───
    if (report.procedure) {
      doc.rect(45, doc.y - 5, doc.page.width - 90, 35)
         .fillAndStroke('#F8F9FC', '#E4E7F0');
      doc.font('Helvetica-Bold').fontSize(10).fillColor('#3B4899')
         .text('PROCEDURE DETAILS', 50, doc.y);
      doc.moveDown(0.5);
      doc.font('Helvetica').fontSize(10).fillColor('#1A202C')
         .text(report.procedure, 50, doc.y, { width: doc.page.width - 100 });
      doc.moveDown(1.2);
    }

    // ─── CLINICAL SECTIONS WITH CARD STYLING ───
    function addSection(title, content, icon = '📋') {
      if (!content || content.trim() === '') return;
      
      doc.moveDown(0.3);
      
      // Section header with icon
      doc.font('Helvetica-Bold').fontSize(12).fillColor('#3B4899')
         .text(`${icon} ${title}`, 50, doc.y, { continued: false });
      
      // Underline
      doc.strokeColor('#E2E8F0').lineWidth(0.5)
         .moveTo(50, doc.y + 2).lineTo(doc.page.width - 50, doc.y + 2).stroke();
      doc.moveDown(0.6);
      
      // Content with proper spacing
      doc.font('Helvetica').fontSize(10).fillColor('#2D3748')
         .text(content, 50, doc.y, {
           width: doc.page.width - 100,
           lineGap: 4,
           align: 'left'
         });
      doc.moveDown(1.2);
    }
    
    // Add all sections with appropriate icons
    addSection('Clinical History', report.clinicalHistory, '📝');
    addSection('Technique', report.technique, '🔬');
    addSection('Findings', report.findings, '🔍');
    addSection('Impression / Conclusion', report.impression, '💡');
    addSection('Recommendation', report.recommendation, '📌');

    // ─── FOOTER WITH SIGNATURE ───
    // Add page number
    const pageCount = doc.bufferedPageRange().count;
    for (let i = 0; i < pageCount; i++) {
      doc.switchToPage(i);
      const oldY = doc.y;
      doc.font('Helvetica').fontSize(8).fillColor('#A0AEC0');
      doc.text(
        `Page ${i + 1} of ${pageCount}`,
        50,
        doc.page.height - 40,
        { align: 'center', width: doc.page.width - 100 }
      );
      doc.y = oldY;
    }
    
    // Go to last page for signature
    doc.switchToPage(pageCount - 1);
    
    // Signature section with divider
    doc.moveDown(2);
    doc.strokeColor('#CBD5E0').lineWidth(0.5)
       .moveTo(50, doc.y).lineTo(doc.page.width - 50, doc.y).stroke();
    doc.moveDown(0.5);
    
    // Date and signature in two columns
    const reportDate = report.reportDate || new Date().toISOString().split('T')[0];
    doc.font('Helvetica').fontSize(9).fillColor('#4A5568')
       .text(`Report Date: ${reportDate}`, 50, doc.y);
    
    // Signature box
    const sigX = doc.page.width - 200;
    const sigY = doc.y;
    
    // Signature line
    doc.strokeColor('#2D3748').lineWidth(0.8)
       .moveTo(sigX, sigY + 10).lineTo(sigX + 150, sigY + 10).stroke();
    
    // Radiologist name
    doc.font('Helvetica-Bold').fontSize(10).fillColor('#2D3748')
       .text(report.radiologist || '_________________________', sigX, sigY + 15, {
         width: 150,
         align: 'center'
       });
    
    doc.font('Helvetica').fontSize(8).fillColor('#718096')
       .text('Reporting Radiologist', sigX, sigY + 30, {
         width: 150,
         align: 'center'
       });
    
    // Footer note
    doc.moveDown(4);
    doc.font('Helvetica-Oblique').fontSize(7).fillColor('#A0AEC0')
       .text('This is a computer-generated report. No signature is required for electronic distribution.', 
         50, doc.y, { align: 'center', width: doc.page.width - 100 });

    doc.end();
  });
}





// ─── SEARCH PATIENT UUID IN OPENMRS ───
async function searchPatientUUID(patientId) {
  const url = `${OPENMRS_BASE}/ws/rest/v1/patient?q=${encodeURIComponent(patientId)}&v=default&limit=1`;
  console.log('Searching patient in OpenMRS:', url);
  const res = await fetch(url, {
    headers: { 'Authorization': OPENMRS_AUTH, 'Accept': 'application/json' },
    agent: httpsAgent,
  });
  if (!res.ok) throw new Error('Patient search failed: ' + res.status + ' ' + (await res.text()));
  const data = await res.json();
  if (!data.results || !data.results.length) throw new Error('Patient not found in OpenMRS for ID: ' + patientId);
  return data.results[0].uuid;
}

// ─── UPLOAD PDF DOCUMENT TO BAHMNI ───
async function uploadDocumentToBahmni(pdfBuffer, patientUuid, filename) {
  const base64Content = 'data:application/pdf;base64,' + pdfBuffer.toString('base64');
  const uploadUrl = `${OPENMRS_BASE}/ws/rest/v1/bahmnicore/visitDocument/uploadDocument`;
  console.log('Uploading PDF to Bahmni:', uploadUrl);
  const res = await fetch(uploadUrl, {
    method: 'POST',
    headers: {
      'Authorization': OPENMRS_AUTH,
      'Content-Type': 'application/json',
      'Accept': 'application/json',
    },
    agent: httpsAgent,
    body: JSON.stringify({
      content: base64Content,
      format: 'pdf',
      encounterTypeName: 'Consultation',
      fileType: 'pdf',
      patientUuid: patientUuid,
    }),
  });
  if (!res.ok) throw new Error('Document upload failed: ' + res.status + ' ' + (await res.text()));
  let filePath = await res.text();
  filePath = filePath.replace(/"/g, '');
  // Bahmni returns {url:PATH} — extract just the path
  const urlMatch = filePath.match(/\{url:(.+?)\}/);
  if (urlMatch) filePath = urlMatch[1];
  console.log('Parsed document path:', filePath);
  return filePath;
}

// ─── LOOKUP ENCOUNTER TYPE UUID FROM OPENMRS ───
async function lookupEncounterTypeUUID(typeName) {
  const url = `${OPENMRS_BASE}/ws/rest/v1/encountertype?q=${encodeURIComponent(typeName)}&v=default`;
  console.log('Looking up encounter type:', url);
  const res = await fetch(url, {
    headers: { 'Authorization': OPENMRS_AUTH, 'Accept': 'application/json' },
    agent: httpsAgent,
  });
  if (!res.ok) throw new Error('Encounter type lookup failed: ' + res.status);
  const data = await res.json();
  if (!data.results || !data.results.length) throw new Error('Encounter type not found: ' + typeName);
  console.log('Found encounter type UUID:', data.results[0].uuid, 'for', typeName);
  return data.results[0].uuid;
}

// ─── FIND RADILOGY ORDER UUID FOR PATIENT ───
// Bahmni order fulfilment display controls usually match observations to an existing order via `orderUuid`.
async function lookupRadiologyOrderUuid(patientUuid, report) {
  // Use v=full so orderType + concept display fields are present for filtering.
  const url = `${OPENMRS_BASE}/ws/rest/v1/order?patient=${encodeURIComponent(patientUuid)}&v=full&limit=200`;
  console.log('Looking up radiology orders:', url);

  const res = await fetch(url, {
    headers: { 'Authorization': OPENMRS_AUTH, 'Accept': 'application/json' },
    agent: httpsAgent,
  });
  if (!res.ok) throw new Error('Order lookup failed: ' + res.status + ' ' + (await res.text()));

  const data = await res.json();
  const orders = Array.isArray(data.results) ? data.results : [];
  const radiologyOrders = orders.filter(o => o?.orderType?.display === 'Radiology Order');

  if (!radiologyOrders.length) {
    throw new Error('No Radiology Orders found for patientUuid=' + patientUuid);
  }

  const procedure = (report?.procedure || '').trim();
  function normalize(s) { return String(s || '').trim().toLowerCase(); }

  let matches = [];
  if (procedure) {
    const p = normalize(procedure);
    matches = radiologyOrders.filter(o => {
      const d = normalize(o?.concept?.display);
      if (!d) return false;
      return d === p || d.includes(p) || p.includes(d);
    });
  }

  const chosenList = matches.length ? matches : radiologyOrders;
  chosenList.sort((a, b) => (b.dateActivated || '').localeCompare(a.dateActivated || ''));
  const chosen = chosenList[0];

  console.log(
    'Chosen radiology orderUuid:',
    chosen.uuid,
    'concept:',
    chosen?.concept?.display,
    'orderNumber:',
    chosen?.orderNumber,
    'orderTypeUuid:',
    chosen?.orderType?.uuid
  );
  return { orderUuid: chosen.uuid, orderTypeUuid: chosen?.orderType?.uuid };
}

// ─── UPDATE LATEST RADIOLOGY FULFILLMENT OBSERVATIONS ───
async function fetchLatestRadiologyFulfillmentOuterObs({ patientUuid, orderUuid, orderTypeUuid }) {
  const url =
    `${OPENMRS_BASE}/ws/rest/v1/bahmnicore/orders` +
    `?concept=${encodeURIComponent('Radiology order fulfillment form')}` +
    `&includeObs=true` +
    `&orderTypeUuid=${encodeURIComponent(orderTypeUuid)}` +
    `&orderUuid=${encodeURIComponent(orderUuid)}` +
    `&patientUuid=${encodeURIComponent(patientUuid)}`;

  const res = await fetch(url, {
    headers: { 'Authorization': OPENMRS_AUTH, 'Accept': 'application/json' },
    agent: httpsAgent,
  });
  if (!res.ok) throw new Error('Failed to fetch fulfillment observations: ' + res.status + ' ' + (await res.text()));

  const data = await res.json();
  if (!Array.isArray(data) || !data.length) throw new Error('No bahmnicore/orders result for orderUuid=' + orderUuid);

  const bahmniObservations = data[0].bahmniObservations;
  if (!Array.isArray(bahmniObservations) || !bahmniObservations.length) {
    throw new Error('No bahmniObservations found for orderUuid=' + orderUuid);
  }

  // Pick the latest by observationDateTime.
  return bahmniObservations
    .slice()
    .sort((a, b) => (b.observationDateTime || 0) - (a.observationDateTime || 0))[0];
}

async function updateObsValue(obsUuid, value) {
  const obsUrl = `${OPENMRS_BASE}/ws/rest/v1/obs/${obsUuid}`;
  const res = await fetch(obsUrl, {
    method: 'POST',
    headers: {
      'Authorization': OPENMRS_AUTH,
      'Content-Type': 'application/json',
      'Accept': 'application/json',
    },
    agent: httpsAgent,
    body: JSON.stringify({ value: value }),
  });
  if (!res.ok) throw new Error('Failed to update obs ' + obsUuid + ': ' + res.status + ' ' + (await res.text()));
  return await res.json();
}

async function updateLatestRadiologyFulfillment(patientUuid, orderUuid, orderTypeUuid, radiologyNotes, documentPath) {
  const latestOuterObs = await fetchLatestRadiologyFulfillmentOuterObs({ patientUuid, orderUuid, orderTypeUuid });
  const summaryGroup = latestOuterObs.groupMembers && latestOuterObs.groupMembers[0];
  if (!summaryGroup || !Array.isArray(summaryGroup.groupMembers)) {
    throw new Error('Latest fulfillment payload missing Summary group for orderUuid=' + orderUuid);
  }

  const notesMember = summaryGroup.groupMembers.find(g => g.conceptUuid === CONCEPT_RADIOLOGY_NOTES);
  if (!notesMember?.uuid) {
    throw new Error('Radiology Notes obs uuid not found for orderUuid=' + orderUuid);
  }

  const imagesMember = summaryGroup.groupMembers.find(g => g.conceptUuid === CONCEPT_DIAGNOSTIC_IMAGES);

  const updatedNotes = await updateObsValue(notesMember.uuid, radiologyNotes);

  let updatedImages = null;
  let imagesUpdated = false;

  // Bahmni's Complex "Diagnostic Images" value appears to require the same
  // storage naming format produced by its own upload flow (notably `__fhir.pdf`).
  // Avoid writing an incompatible value (it may be ignored or voided).
  const shouldUpdateImages = Boolean(documentPath && documentPath.includes('__fhir.pdf'));
  if (shouldUpdateImages && imagesMember?.uuid) {
    updatedImages = await updateObsValue(imagesMember.uuid, documentPath);
    imagesUpdated = Boolean(updatedImages?.display && updatedImages.display.includes(documentPath));
  } else {
    if (imagesMember?.uuid && documentPath) {
      console.warn(
        'Skipping Diagnostic Images update for orderUuid=' + orderUuid +
          ' because documentPath is missing __fhir.pdf: ' + documentPath
      );
    }
  }

  return {
    latestOuterObsUuid: latestOuterObs.uuid,
    updatedNotes,
    updatedImages,
    imagesUpdated: imagesUpdated,
  };
}

// When the Radiology order fulfillment has never been filled for this order yet,
// Bahmni won't return existing `bahmniObservations`, so we need to create the
// initial observations. For now, we create Radiology Notes only (avoids
// Complex `Diagnostic Images` value issues when we don't have Bahmni's exact
// expected `__fhir.pdf` payload).
async function createBahmniRadiologyFulfillmentNotesOnly(patientUuid, orderUuid, radiologyNotes) {
  const encounterUrl = `${OPENMRS_BASE}/ws/rest/v1/bahmnicore/bahmniencounter`;

  const notesObs = {
    concept: { uuid: CONCEPT_RADIOLOGY_NOTES, name: 'Radiology Notes', dataType: 'Text' },
    units: null,
    label: 'Radiology Notes',
    possibleAnswers: [],
    groupMembers: [],
    comment: null,
    isObservation: true,
    conceptUIConfig: [],
    uniqueId: 'observation_1',
    erroneousValue: null,
    value: radiologyNotes,
    autocompleteValue: radiologyNotes,
    __prevValue: radiologyNotes,
    _value: radiologyNotes,
    disabled: false,
    orderUuid: orderUuid,
    voided: false,
  };

  const payload = {
    locationUuid: BAHMNI_LOCATION_UUID,
    patientUuid: patientUuid,
    observations: [
      {
        concept: { uuid: CONCEPT_RADIOLOGY_FORM, name: 'Radiology order fulfillment form', dataType: 'N/A' },
        units: null,
        label: 'Radiology order fulfillment form',
        possibleAnswers: [],
        groupMembers: [
          {
            concept: { uuid: CONCEPT_SUMMARY, name: 'Summary', dataType: 'N/A' },
            units: null,
            label: 'Summary',
            possibleAnswers: [],
            groupMembers: [notesObs],
            comment: null,
            isObservation: true,
            conceptUIConfig: [],
            uniqueId: 'observation_3',
            erroneousValue: null,
            orderUuid: orderUuid,
            voided: false,
          },
        ],
        comment: null,
        isObservation: true,
        conceptUIConfig: [],
        uniqueId: 'observation_4',
        erroneousValue: null,
        conceptSetName: 'Radiology Order Fulfillment Form',
        orderUuid: orderUuid,
        voided: false,
      },
    ],
    // Keep Bahmni association consistent with the UI-copied payload.
    orders: [],
    drugOrders: [],
    providers: [{ uuid: BAHMNI_PROVIDER_UUID }],
  };

  const res = await fetch(encounterUrl, {
    method: 'POST',
    headers: {
      'Authorization': OPENMRS_AUTH,
      'Content-Type': 'application/json',
      'Accept': 'application/json',
    },
    agent: httpsAgent,
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    throw new Error('Radiology fulfillment create failed: ' + res.status + ' ' + (await res.text()));
  }

  return await res.json();
}

// ─── SEND REPORT TO BAHMNI (PDF + Encounter) ───
app.post('/api/send-report-to-bahmni', async (req, res) => {
  try {
    const report = req.body;
    console.log('=== Sending report to Bahmni for patient:', report.patientId, '===');

    // Step 1: Search patient UUID in OpenMRS
    const patientUuid = await searchPatientUUID(report.patientId);
    console.log('Found patient UUID:', patientUuid);

    // Step 1b: Find the correct Radiology Order UUID for this patient
    // (Needed so the patient dashboard "Radiology Orders" control can show observations.)
    const { orderUuid, orderTypeUuid } = await lookupRadiologyOrderUuid(patientUuid, report);
    if (!orderUuid || !orderTypeUuid) {
      throw new Error('Could not resolve orderUuid/orderTypeUuid for patientId=' + report.patientId);
    }

    // Step 2: Generate PDF from report data
    const pdfBuffer = await generateReportPDF(report);
    console.log('PDF generated, size:', pdfBuffer.length, 'bytes');

    // Step 3: Upload PDF to Bahmni document storage
    let documentPath = null;
    try {
      const filename = 'RadiologyReport_' + (report.accessionNumber || 'unknown').replace(/[^a-zA-Z0-9-_]/g, '') + '.pdf';
      documentPath = await uploadDocumentToBahmni(pdfBuffer, patientUuid, filename);
      console.log('Document uploaded to Bahmni, path:', documentPath);
    } catch (uploadErr) {
      console.warn('PDF upload to Bahmni failed (continuing without attachment):', uploadErr.message);
    }

    // Step 4: Update latest radiology fulfillment observations (so it shows at -1)
    const radiologyNotes = [
      report.findings ? 'Findings: ' + report.findings : '',
      report.impression ? 'Impression: ' + report.impression : '',
      report.recommendation ? 'Recommendation: ' + report.recommendation : '',
    ].filter(Boolean).join('\n\n');

    let updateResult = null;
    try {
      updateResult = await updateLatestRadiologyFulfillment(
        patientUuid,
        orderUuid,
        orderTypeUuid,
        radiologyNotes,
        documentPath
      );
      console.log('=== Radiology fulfillment updated successfully ===');
    } catch (updateErr) {
      // If there are no prior fulfillment observations for this order,
      // create initial observations so the patient dashboard can show at -1.
      const msg = String(updateErr?.message || updateErr);
      if (msg.includes('No bahmniObservations found for orderUuid=')) {
        console.warn('No fulfillment observations yet; creating notes-only fulfillment for orderUuid=' + orderUuid);
        const created = await createBahmniRadiologyFulfillmentNotesOnly(patientUuid, orderUuid, radiologyNotes);
        res.json({
          message: 'Report sent to Bahmni successfully (notes-only created)',
          patientUuid,
          orderUuid,
          orderTypeUuid,
          documentPath,
          createdBahmni: true,
          notesCreated: true,
          notesOnly: true,
          encounterUuid: created.encounterUuid || created.uuid,
        });
        return;
      }
      throw updateErr;
    }

    res.json({
      message: 'Report sent to Bahmni successfully',
      patientUuid,
      orderUuid,
      orderTypeUuid,
      documentPath,
      imagesUpdated: updateResult.imagesUpdated,
      notesObsUuid: updateResult.updatedNotes?.uuid,
      imagesObsUuid: updateResult.updatedImages?.uuid || null,
    });
  } catch (err) {
    console.error('Send to Bahmni error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── DOWNLOAD REPORT AS PDF ───
app.get('/api/reports/:id/pdf', async (req, res) => {
  try {
    const filepath = path.join(REPORTS_DIR, req.params.id + '.json');
    if (!fs.existsSync(filepath)) return res.status(404).json({ error: 'Report not found' });
    const report = JSON.parse(fs.readFileSync(filepath, 'utf-8'));
    const pdfBuffer = await generateReportPDF(report);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'inline; filename="' + req.params.id + '.pdf"');
    res.send(pdfBuffer);
  } catch (err) {
    console.error('PDF generation error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`MWL Order App running at http://localhost:${PORT}`);
});
