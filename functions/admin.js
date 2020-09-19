var admin = require('firebase-admin');
var serviceAccount = require("./serviceAccountKey/pono-a5755-firebase-adminsdk-6rcwn-018fe70c83.json");
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: "https://pono-a5755.firebaseio.com",
  storageBucket: "gs://pono-a5755.appspot.com"
});
exports.admin = admin;
