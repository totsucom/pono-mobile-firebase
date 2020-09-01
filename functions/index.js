'use strict';

const functions = require('firebase-functions');
const mkdirp = require('mkdirp');
const admin = require('firebase-admin');
admin.initializeApp();
const path = require('path');
const os = require('os');
const fs = require('fs');
//const { info } = require('console');
const { createCanvas, loadImage } = require('canvas');
const ExifImage = require('exif').ExifImage;


// サムネイルのサイズ
const THUMB_SIZE = 200;

// サムネイルファイル名に付けるプレフィックス名
const THUMB_PREFIX = 'thumb_';


// 署名付きURLを取得する
async function getUrlFromFile(bucketFile) {
  const result = await bucketFile.getSignedUrl(
    {action: 'read', expires: '03-01-2500'});
  return result[0];
}



/*
 * basePicturesコレクションに変更があった場合に呼び出される
 * 
 */
exports.handleImagesForBasePictures = functions.firestore
  .document('basePictures/{documentID}').onWrite(async (change, context) => {

  if (change.after.exists) {
    if (!change.before.exists) {
      //ベース写真が追加された
      console.log('ベース写真が追加された');
      const message = await generateBasePictureImage(change.after.data(), change.after.id);
      return console.log('handleImagesForBasePictures: ' + message);
    } else {
      //ベース写真が更新された
      //写真ありきのコレクションなので、写真が変更されることはない
      return console.log('handleImagesForBasePictures: DB更新は処理しない');
    }
  } else {
    //ベース写真が削除された
    console.log('ベース写真が削除された');
    const message = await deleteProblemImages(change.before.data(), change.before.id);
    return console.log('handleImagesForBasePictures: ' + message);
  }
});

//無いときは undefined
function getOrientation(file) {
  console.log(file);
  return new Promise(function(resolve, reject) {
    try {
      new ExifImage({image: file}, function (error, exifData) {
          if (error)
            resolve(undefined);
          else {
            console.log(exifData);
            resolve(exifData.image.Orientation);
          }
      });
    } catch (error) {
      resolve(undefined);
    }
  });
}

async function generateBasePictureImage(snap, docID) {

  const contentType = 'image/png';
  const extension = '.png';

  const COLLECTION_NAME = 'basePictures';
  //const IMAGE_URL_FIELD_NAME = 'pictureURL';          //write
  const THUMB_IMAGE_URL_FIELD_NAME = 'thumbnailURL';  //write

  //元画像のStorage情報
  const originalStoragePath = snap.picturePath;     //DBから取得
  const originalName = path.basename(originalStoragePath);
  const storageDir = path.dirname(originalStoragePath);

  //元画像のLocal情報
  const originalLocalPath = path.join(os.tmpdir(), originalName);
  const localDir = path.dirname(originalLocalPath);

  //サムネイルのStorage情報
  const thumbName = THUMB_PREFIX + originalName
    .substr(0, originalName.length - path.extname(originalName).length)
    + extension;
  const thumbStoragePath = path.join(storageDir, thumbName);

  //サムネイル像のLocal情報
  const thumbLocalPath = path.join(os.tmpdir(), thumbName);

  console.log('ストレージパス ' + originalStoragePath + ' ' + thumbStoragePath);
  console.log('ローカルパス ' + originalLocalPath + ' ' + thumbLocalPath);

  //Storageオブジェクトを作成
  const bucket = admin.storage().bucket();
  const originalFile = bucket.file(originalStoragePath);
  const thumbFile = bucket.file(thumbStoragePath);

  //元画像をダウンロードする
  //const originalURL = await getUrlFromFile(originalFile);
  //const originalImage = await loadImage(originalURL);
  await mkdirp(localDir);
  await originalFile.download({destination: originalLocalPath});
  const originalImage = await loadImage(originalLocalPath);
 
  //Exif情報からOrientationを取得
  const orientation = await getOrientation(originalLocalPath);
  var angle = 0.0;
  if (orientation == 3) angle = 180.0;
  else if (orientation == 6) angle = 90.0;
  else if (orientation == 8) angle = 270.0;

  const canvas = createCanvas(THUMB_SIZE, THUMB_SIZE);
  const ctx = canvas.getContext('2d');

  ctx.beginPath();
  ctx.fillStyle = "rgba(255, 255, 255, 0.0)";
  ctx.fillRect(0, 0, THUMB_SIZE, THUMB_SIZE);
  ctx.stroke();

  ctx.translate(THUMB_SIZE/2, THUMB_SIZE/2);
  ctx.rotate(angle / 180.0 * Math.PI);

  var scale_x = THUMB_SIZE / originalImage.width;
  var scale_y = THUMB_SIZE / originalImage.height;
  var scale = (scale_y < scale_x) ? scale_y : scale_x;

  var dw = originalImage.width * scale;
  var dh = originalImage.height * scale;
  var dx = -dw / 2;
  var dy = -dh / 2;

  ctx.drawImage(originalImage, 0, 0, originalImage.width, originalImage.height,
    dx, dy, dw, dh);


  //一時フォルダを作成し、キャンバスの内容をローカルファイルに保存
  //await mkdirp(localDir);
  var b64data = canvas.toDataURL(contentType).split(',')[1];
  var buffer = new Buffer(b64data, 'base64');
  fs.writeFileSync(thumbLocalPath, buffer);

  //ストレージにアップロードする
  await bucket.upload(thumbLocalPath,
    {destination:thumbFile, metadata: {contentType: contentType}});

  //一時ファイルを削除する
  fs.unlinkSync(thumbLocalPath);

  //URLを取得する
  const thumbURL = await getUrlFromBucket(thumbFile);

  //DBに保存
  var data = {};
  //data[IMAGE_URL_FIELD_NAME] = originalURL;
  data[THUMB_IMAGE_URL_FIELD_NAME] = thumbURL;
  await admin.firestore().collection(COLLECTION_NAME).doc(docID).update(data);

  return thumbURL;
}

async function deleteProblemImages(snap, docID) {

  //元画像のStorage情報
  const originalStoragePath = snap.basePicturePath;     //DBから取得
  const originalName = path.basename(originalStoragePath);
  const storageDir = path.dirname(originalStoragePath);

  //サムネイルのStorage情報
  const thumbStoragePath = path.normalize(
    path.join(storageDir, `${THUMB_PREFIX}${originalName}`));

  //Storageオブジェクトを作成
  const bucket = admin.storage().bucket(object.bucket);
  const originalFile = bucket.file(originalStoragePath);
  const thumbFile = bucket.file(thumbStoragePath);

  var message = '';
  try {
    await originalFile.delete();
    message += '元画像を削除しました '
  } catch (e) { }
  try {
    await thumbFile.delete();
    message += 'サムネイルを削除しました '
  } catch (e) { }

  if (message.length == 0) message = '画像は削除しませんでした';
  return message;
}

/*
 * problemコレクションに変更があった場合に呼び出される
 * 
 */
exports.handleImagesForProblem = functions.firestore
  .document('problems/{documentID}').onWrite(async (change, context) => {

  if (change.after.exists) {
    if (!change.before.exists) {
      //課題が追加された
      console.log('課題が追加された');
      await updateProblemImages(change.after.data(), change.after.id);
    } else {
      //課題が更新された
      const snap = change.after.data();
      if (snap.imageRequired) { //更新時はフラグ次第
        console.log('課題が更新された');
        await updateProblemImages(change.after.data(), change.after.id);
      }
    }
  } else {
    //課題が削除された
    console.log('課題が削除された');
    await deleteProblemImages(change.before.data(), change.before.id);
  }

  return console.log('handleImagesForProblem 完了');
});

//キャンバスの内容をファイルに書き出す
async function saveCanvas(canvas, filePath) {
  var b64data = canvas.toDataURL("image/jpeg", 0.75).split(',')[1];
  var buffer = new Buffer(b64data, 'base64');
  fs.writeFileSync(filePath, buffer);
}

// 署名付きURLを取得する
async function getUrlFromBucket(bucketFile) {
  const result = await bucketFile.getSignedUrl(
    {action: 'read', expires: '03-01-2500'});
  return result[0];
}

async function updateProblemImages(snap, docID) {
  const { createCanvas, loadImage } = require('canvas');

  console.log("ID = " + docID);

  const COLLECTION_NAME = 'problems';
  const IMGE_OUTPUT_PATH = 'problemImages/completedImages';


  const basePicturePath = snap.basePicturePath;
  console.log("basePicturePath = " + basePicturePath);
  const basePictureName = path.basename(basePicturePath);

  const tempLocalFile = path.join(os.tmpdir(), basePictureName);
  console.log("tempLocalFile = " + tempLocalFile);
  const tempLocalDir = path.dirname(tempLocalFile);



  const bucket = admin.storage().bucket();
  const basePictureURL = await getUrlFromBucket(bucket.file(basePicturePath));
  console.log("basePictureURL = " + basePictureURL);
  const basePicture = await loadImage(basePictureURL);


  const canvas = createCanvas(basePicture.width, basePicture.height);
  const ctx = canvas.getContext('2d');

  ctx.drawImage(basePicture, 0, 0);

  //適当に描画
  ctx.beginPath () ;
  ctx.moveTo( 0, 0 ) ;
  ctx.lineTo( 200, 200 );
  ctx.strokeStyle = "red" ;
  ctx.lineWidth = 10 ;
  ctx.stroke() ;

  // 一時フォルダを作成する
  await mkdirp(tempLocalDir);

  // キャンバスを一時ファイルに保存
  await saveCanvas(canvas, tempLocalFile);

  // Storage用のオブジェクトを準備
  const completedImagePath = `${IMGE_OUTPUT_PATH}/${docID}.jpg`;
  const completedImageFile = bucket.file(completedImagePath);
  const metadata = {
    contentType: 'image/jpeg',//contentType,
    //'Cache-Control': 'public,max-age=3600', // For client side
  };

  // キャンバスファイルを FirebaseCloudStorage にアップロードする
  await bucket.upload(tempLocalFile,
    {destination:completedImagePath, metadata: metadata});

  // 一時フォルダ内の一時ファイルを削除する
  fs.unlinkSync(tempLocalFile);

  // 署名付きURLを取得する
  const completedImageURL = await getUrlFromBucket(completedImageFile);
  console.log("completedImageURL = " + completedImageURL);

  // Firestore のコレクションを更新
  /*await snap.ref.set({
    //decodeURI()を使ってもFirestoreに格納されるURLは%でエスケープされてしまうので注意
    completedImageURL: completedImageURL,
    generateImageRequired: false
  });*/
  await admin.firestore().collection(COLLECTION_NAME).doc(docID).set({
    //decodeURI()を使ってもFirestoreに格納されるURLは%でエスケープされてしまうので注意
    completedImageURL: completedImageURL,
    imageRequired: false
  });

  console.log('handleImagesForProblem.updateProblemImages: 完了 ' + docID);
}

async function deleteProblemImages(snap, docID) {
  const filePath = 'problemImages/completedImages/{docID}.jpg';

  // Cloud Storage files.
  const bucket = admin.storage().bucket();
  const file = bucket.file(filePath);
  
  try {
    file.delete();
  } catch (e) {
  }
}
