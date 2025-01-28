// api/convert.js

const formidable = require('formidable');
const fs = require('fs-extra');
const path = require('path');
const decompress = require('decompress');
const creator = require('../src/creator').default;
const csvWriter = require('csv-writer').createObjectCsvWriter;
const filesize = require('filesize');
const _ = require('lodash');
const chalk = require('chalk');

export const config = {
  api: {
    bodyParser: false, // Disable Vercel's default body parser
  },
};

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  const form = new formidable.IncomingForm();
  // Define temporary directories in /tmp (Vercel's writable directory)
  const uploadTmpDir = path.join('/tmp', 'downloads_tmp');
  const h5pContentBaseDir = path.join('/tmp', 'workspace');
  const tempBaseDir = path.join('/tmp', 'temp');
  const outputDir = path.join('/tmp', 'output');

  try {
    // Ensure working directories exist
    await fs.ensureDir(uploadTmpDir);
    await fs.ensureDir(h5pContentBaseDir);
    await fs.ensureDir(tempBaseDir);
    await fs.ensureDir(outputDir);

    const data = await new Promise((resolve, reject) => {
      form.parse(req, (err, fields, files) => {
        if (err) reject(err);
        else resolve({ fields, files });
      });
    });

    const { h5p_file } = data.files;
    const masteryScore = data.fields.h5p_mastery_score || 100;

    if (!h5p_file) {
      return res.status(400).json({ error: 'You must upload a H5P file.' });
    }

    const uploadedFilePath = path.join(uploadTmpDir, h5p_file.originalFilename);
    await fs.move(h5p_file.filepath, uploadedFilePath, { overwrite: true });

    // Uncompress H5P file
    const workspaceName = path.join(h5pContentBaseDir, path.basename(uploadedFilePath, '.h5p'));
    await decompress(uploadedFilePath, workspaceName);
    await fs.remove(uploadedFilePath);

    // Package SCORM
    let filename = '';
    try {
      filename = await creator(outputDir, workspaceName, path.join(tempBaseDir, path.basename(uploadedFilePath, '.h5p')), masteryScore);
    } catch (error) {
      console.error(chalk.red('Error during SCORM packaging:', error));
      return res.status(500).json({ error: 'Error during SCORM packaging. Please try again.' });
    } finally {
      await fs.remove(workspaceName);
    }

    if (!filename) {
      return res.status(500).json({ error: 'Failed to create SCORM package.' });
    }

    // Prepare SCORM package path
    const scormFilePath = path.join(outputDir, filename);

    // Stream the SCORM package back to the user
    res.setHeader('Content-Disposition', `attachment; filename=${filename}`);
    res.setHeader('Content-Type', 'application/zip');

    const fileStream = fs.createReadStream(scormFilePath);
    fileStream.pipe(res);

    fileStream.on('close', async () => {
      await fs.remove(scormFilePath);
    });

  } catch (err) {
    console.error(chalk.red('Error processing conversion:', err));
    res.status(500).json({ error: 'Internal Server Error' });
  }
}
