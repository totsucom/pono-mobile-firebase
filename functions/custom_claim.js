const functions = require('firebase-functions');

const adminjs = require('./admin');


/*const admin = require('firebase-admin');
var serviceAccount = require("./serviceAccountKey/pono-a5755-firebase-adminsdk-6rcwn-018fe70c83.json");
adminjs.admin.initializeApp({
  credential: adminjs.admin.credential.cert(serviceAccount),
  databaseURL: "https://pono-a5755.firebaseio.com"
});*/

const express = require('express');
const cors = require('cors')({ origin: true });
const bodyParser = require('body-parser')
const app = express();



app.use(cors);
app.use(express.json());

app.use(bodyParser.urlencoded({ extended: true }))
app.use(bodyParser.json())

// いるんか？
app.get('/', (req, res) => {
  res.end(JSON.stringify({status: 'success'}))
});

// Custom Claimes に設定されているフラグを返す
app.post('/getClaims', (req, res) => {

  const idToken = req.body.idToken;
  const targetUid = req.body.targetUid;

  // 依頼者を認証する
  adminjs.admin.auth().verifyIdToken(idToken)
    .then((claims) => {

      // ターゲットユーザーを取得する
      adminjs.admin.auth().getUser(targetUid).then((user) => {

        // Custom claims を取得する
        const currentCustomClaims = user.customClaims;
        res.end(JSON.stringify({
          displayName: user.displayName,
          status: 'success',
          claims: (typeof currentCustomClaims !== 'undefined')
            ? currentCustomClaims : '<Empty>'
        }));
      }).catch((err) => {
        console.log('get error, ' + err);
        res.end(JSON.stringify({status: 'error', error: err}));
      });
    }).catch((err) => {
      console.log('set admin error (user verification), ' + err);
      res.end(JSON.stringify({status: 'error', error: err}));
    })
});


// Custom Claimes に admin フラグを設定する
app.post('/setAdmin', (req, res) => {

  const idToken = req.body.idToken;
  const targetUid = req.body.targetUid;

  // 依頼者を認証する
  adminjs.admin.auth().verifyIdToken(idToken)
    .then((claims) => {

      // ターゲットユーザーを取得する(displayNameを得たいだけ)
      adminjs.admin.auth().getUser(targetUid).then((user) => {

        // Custom Claimes に admin フラグを設定する
        adminjs.admin.auth().setCustomUserClaims(targetUid, { admin: true })
          .then(function() {
            console.log('set admin => ' + targetUid);
            res.end(JSON.stringify({
              displayName: user.displayName,
              status: 'success'
            }));
          }).catch((err) => {
            console.log('set admin error, ' + err);
            res.end(JSON.stringify({status: 'error', error: err}));
          });
      }).catch((err) => {
        console.log('get error, ' + err);
        res.end(JSON.stringify({status: 'error', error: err}));
      });
    }).catch((err) => {
      console.log('set admin error (user verification), ' + err);
      res.end(JSON.stringify({status: 'error', error: err}));
    })
});

// Custom Claimes から admin フラグを削除する
app.post('/removeAdmin', (req, res) => {

  const idToken = req.body.idToken;
  const targetUid = req.body.targetUid;

  // 依頼者を認証する
  adminjs.admin.auth().verifyIdToken(idToken)
    .then((claims) => {

      // ターゲットユーザーを取得する(displayNameを得たいだけ)
      adminjs.admin.auth().getUser(targetUid).then((user) => {

        // Custom Claimes に admin フラグを設定する
        adminjs.admin.auth().setCustomUserClaims(targetUid, { })
          .then(function() {
            console.log('remove admin => ' + targetUid);
            res.end(JSON.stringify({
              displayName: user.displayName,
              status: 'success'
            }));
          }).catch((err) => {
            console.log('remove admin error, ' + err);
            res.end(JSON.stringify({status: 'error', error: err}));
          });
      }).catch((err) => {
        console.log('get error, ' + err);
        res.end(JSON.stringify({status: 'error', error: err}));
      });
    }).catch((err) => {
      console.log('remove admin error (user verification), ' + err);
      res.end(JSON.stringify({status: 'error', error: err}));
    })
});

exports.app = functions.https.onRequest(app);
