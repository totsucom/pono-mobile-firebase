'use strict';

var functions = require('firebase-functions');

const images = require('./images');
exports.handleImagesForBasePictures = images.handleImagesForBasePictures;

const customClaim = require('./custom_claim');
exports.app = customClaim.app;

const problems = require('./problems');
exports.handleImagesForProblems = problems.handleImagesForProblems;


