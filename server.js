const express = require('express');
const fetch = require('node-fetch');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const crypto = require('crypto');

const REPORTS_DIR = path.join(__dirname, 'reports');
if (!fs.existsSync(REPORTS_DIR)) fs.mkdirSync(REPORTS_DIR);

const app = express();
const PORT = 3080;

const DCM4CHEE_BASE = 'http://178.236.185.39:8085';
const AE_TITLE = 'DCM4CHEE';
const MWL_AE_TITLE = 'WORKLIST';

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

app.listen(PORT, () => {
  console.log(`MWL Order App running at http://localhost:${PORT}`);
});
