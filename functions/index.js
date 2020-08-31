'use strict';

const functions = require('firebase-functions');
const mkdirp = require('mkdirp');
const admin = require('firebase-admin');
admin.initializeApp();
const spawn = require('child-process-promise').spawn;
const path = require('path');
const os = require('os');
const fs = require('fs');
/*
import { runWith, storage, firestore as _firestore } from 'firebase-functions';
import mkdirp from 'mkdirp';
import { initializeApp, firestore as __firestore, storage as _storage } from 'firebase-admin';
initializeApp();
const firestore = __firestore;
import { spawn } from 'child-process-promise';
import { dirname, basename, normalize, join } from 'path';
import { tmpdir } from 'os';
import { unlinkSync, writeFileSync } from 'fs';
*/

// サムネイルの最大サイズ
const THUMB_MAX_HEIGHT = 200;
const THUMB_MAX_WIDTH = 200;

// サムネイルファイル名に付けるプレフィックス名
const THUMB_PREFIX = 'thumb_';


/*
 * ベース写真がアップロードされたらサムネイルを生成し、Firestoreに情報を書き出す
 */
exports.generateThumbnail = functions.runWith({
  timeoutSeconds: 60, //60秒はデフォルト
  memory: '1GB'       //ImageMagick の-auto-orientオプションでは256MBで不足
}).storage.object().onFinalize(async (object) => {

  // サムネイル情報を書き出す、Firestoreのコレクション名
  const COLLECTION_NAME = 'thumbnails';

  // File and directory paths.
  const filePath = object.name;
  const contentType = object.contentType; // This is the image MIME type
  const fileDir = path.dirname(filePath);
  const fileName = path.basename(filePath);
  const thumbFilePath = path.normalize(path.join(fileDir, `${THUMB_PREFIX}${fileName}`));
  const tempLocalFile = path.join(os.tmpdir(), filePath);
  const tempLocalDir = path.dirname(tempLocalFile);
  const tempLocalThumbFile = path.join(os.tmpdir(), thumbFilePath);

  if (['basePictures'].indexOf(fileDir) < 0) {
    return console.log('generateThumbnail: 監視フォルダでない');
  }

  if (!contentType.startsWith('image/')) {
    return console.log('generateThumbnail: イメージファイルでない');
  }

  if (fileName.startsWith(THUMB_PREFIX)) {
    return console.log('generateThumbnail: サムネイルファイルには処理を行わない');
  }

  // Cloud Storage files.
  const bucket = admin.storage().bucket(object.bucket);
  const file = bucket.file(filePath);
  const thumbFile = bucket.file(thumbFilePath);
  const metadata = {
    contentType: contentType,
    // To enable Client-side caching you can set the Cache-Control headers here.
    // Uncomment below.
    // 'Cache-Control': 'public,max-age=3600',
  };
  
  // 一時フォルダを作成する
  await mkdirp(tempLocalDir);
  
  // 対象の画像ファイルを FirebaseCloudStorage から一時フォルダにダウンロードする
  await file.download({destination: tempLocalFile});

  // 一時フォルダ内で ImageMagick を使ってサムネイルを作成する
  //await spawn('convert', [
  //    tempLocalFile, '-thumbnail',
  //    `${THUMB_MAX_WIDTH}x${THUMB_MAX_HEIGHT}>`, tempLocalThumbFile
  //  ], {capture: ['stdout', 'stderr']});
  await spawn('convert', [
      tempLocalFile, '-auto-orient', '-resize',
      `${THUMB_MAX_WIDTH}x${THUMB_MAX_HEIGHT}>`, tempLocalThumbFile
    ], {capture: ['stdout', 'stderr']});

  // 作成したサムネイルを FirebaseCloudStorage にアップロードする
  await bucket.upload(tempLocalThumbFile, {destination: thumbFilePath, metadata: metadata});

  // 一時フォルダ内の一時ファイルを削除する
  fs.unlinkSync(tempLocalFile);
  fs.unlinkSync(tempLocalThumbFile);

  // 署名付きURLを取得する
  const config = {
    action: 'read',
    expires: '03-01-2500',
  };
  const results = await Promise.all([
    thumbFile.getSignedUrl(config),
    file.getSignedUrl(config),
  ]);
  const thumbResult = results[0];
  const originalResult = results[1];
  const thumbFileUrl = thumbResult[0];
  const fileUrl = originalResult[0];

  /* ここからFirestoreに独自形式でコレクションを作成 */

  // ファイルパスからドキュメントIDを作成
  // （これでユーザーアプリケーションはファイルパスからサムネイルデータにたどり着ける）
  const docID = filePath.replace('\\',':').replace('/',':')

  // Firestore にコレクションを追加
  await admin.firestore().collection(COLLECTION_NAME).doc(docID).set({
    path: filePath,
    originalURL: fileUrl,       //decodeURI()を使ってもFirestoreに格納
    thumbnailURL: thumbFileUrl, //されるURLは%でエスケープされてしまうので注意
    createdAt: admin.firestore.FieldValue.serverTimestamp()
  });
  return console.log('generateThumbnail: サムネイルが作成され、Firestore に追加されました。 DocID=' + docID);
});

/*
 * ベース写真が削除されたらサムネイル画像とFirestoreのサムネイル情報を削除する
 */
exports.deleteThumbnail = functions.storage.object()
  .onDelete(async (object) => {
  
    // File and directory paths.
  const filePath = object.name;
  const contentType = object.contentType; // This is the image MIME type
  const fileDir = path.dirname(filePath);
  const fileName = path.basename(filePath);
  const thumbFilePath = path.normalize(path.join(fileDir, `${THUMB_PREFIX}${fileName}`));

  if (['basePictures'].indexOf(fileDir) < 0) {
    return console.log('deleteThumbnail: 監視フォルダでない');
  }

  if (!contentType.startsWith('image/')) {
    return console.log('deleteThumbnail: イメージファイルでない');
  }

  if (fileName.startsWith(THUMB_PREFIX)) {
    return console.log('deleteThumbnail: サムネイルファイルには処理を行わない');
  }

  // Cloud Storage files.
  const bucket = admin.storage().bucket(object.bucket);
  const file = bucket.file(thumbFilePath);

  // 削除されたファイルの先頭に単純に thumb_ を付けて削除してみる
  var message;
  try {
    await file.delete();
    message = 'ファイル削除成功 ';
  }
  catch (e) {
    message = 'ファイル削除失敗 ';
  }

  // ファイルパスからドキュメントIDを作成
  const docID = filePath.replace('\\','-').replace('/','-')

  // ドキュメントIDのコレクションを削除してみる
  try {
    await admin.firestore().collection(COLLECTION_NAME).doc(docID).delete();
    message += 'コレクション削除成功';
  }
  catch (e) {
    message += 'コレクション削除失敗';
  }

  return console.log('deleteThumbnail: 処理が完了しました。' + message);
});

/*
 * problemコレクションに変更があった場合に呼び出される
 * 
 */
exports.handleImagesForProblem = functions.firestore
  .document('problems/{documentID}').onWrite((change, context) => {

  if (change.after.exists) {
    if (!change.before.exists) {
      //課題が追加された
      updateProblemImages(change.after.data(), change.after.id);
    } else {
      //課題が更新された
      const snap = change.after.data();
      if (snap.generateImageRequired)
        updateProblemImages(change.after.data(), change.after.id);
    }
  } else {
    //課題が削除された
    deleteProblemImages(change.before.data(), change.before.id);
  }

  return console.log('handleImagesForProblem 終わり');
});

//キャンバスの内容をファイルに書き出す
function saveCanvas(canvas, filePath) {
  var b64data = canvas.toDataURL("image/jpeg", 0.75).split(',')[1];
  var buffer = new Buffer(b64data, 'base64');
  writeFileSync(filePath, buffer);
}

// 署名付きURLを取得する
async function getUrlFromBucket(bucketFile) {
  const result = await bucketFile.getSignedUrl(
    {action: 'read', expires: '03-01-2500'});
  return result1[0];
}

async function updateProblemImages(snap, docID) {

  const COLLECTION_NAME = 'problem';

  const filePath = 'problemImages/completedImages/{docID}.jpg';
  const tempLocalFile = path.join(os.tmpdir(), filePath);
  const tempLocalDir = path.dirname(tempLocalFile);

  const { createCanvas, loadImage } = require('canvas');


  const bucket = admin.storage().bucket(object.bucket);
  const basePictureURL = await getUrlFromBucket(bucket.file(filePath));
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

  // キャンバスをファイルに保存
  saveCanvas(canvas, tempLocalFile);

  // Cloud Storage files.
  const file = bucket.file(filePath);
  const metadata = {
    contentType: contentType,
    // To enable Client-side caching you can set the Cache-Control headers here.
    // Uncomment below.
    // 'Cache-Control': 'public,max-age=3600',
  };

  // キャンバスファイルを FirebaseCloudStorage にアップロードする
  await bucket.upload(tempLocalFile, {destination:filePath, metadata: metadata});

  // 一時フォルダ内の一時ファイルを削除する
  fs.unlinkSync(tempLocalFile);

  // 署名付きURLを取得する
  const fileUrl = getUrlFromBucket(file);

  // Firestore のコレクションを更新
  await admin.firestore().collection(COLLECTION_NAME).doc(docID).set({
    completedImageURL: fileUrl, //decodeURI()を使ってもFirestoreに格納
                                //されるURLは%でエスケープされてしまうので注意
    generateImageRequired: false
  });

  console.log('handleImagesForProblem.updateProblemImages: 完了 ' + docID);
}

async function deleteProblemImages(snap, docID) {
  const filePath = 'problemImages/completedImages/{docID}.jpg';

  // Cloud Storage files.
  const bucket = admin.storage().bucket(object.bucket);
  const file = bucket.file(filePath);
  
  try {
    file.delete();
  } catch (e) {
  }
}

/*
export const test = storage.object().onFinalize(async (object) => {

  // サムネイルファイル名に付けるプレフィックス名
  const THUMB_PREFIX = 'thumb_';

  // サムネイル情報を書き出す、Firestoreのコレクション名
  const COLLECTION_NAME = 'thumbnails';

  // File and directory paths.
  const filePath = object.name;
  const contentType = object.contentType; // This is the image MIME type
  const fileDir = path.dirname(filePath);
  const fileName = path.basename(filePath);
  const thumbFilePath = path.normalize(path.join(fileDir, `${THUMB_PREFIX}${fileName}`));
  const tempLocalFile = path.join(os.tmpdir(), filePath);
  const tempLocalDir = path.dirname(tempLocalFile);
  const tempLocalThumbFile = path.join(os.tmpdir(), thumbFilePath);

  if (['problemImages'].indexOf(fileDir) < 0) {
    return console.log('test: 監視フォルダでない');
  }

  if (!contentType.startsWith('image/')) {
    return console.log('test: イメージファイルでない');
  }

  if (fileName.startsWith(THUMB_PREFIX)) {
    return console.log('test: サムネイルファイルには処理を行わない');
  }

  // Cloud Storage files.
  const bucket = admin.storage().bucket(object.bucket);
  const file = bucket.file(filePath);
  const thumbFile = bucket.file(thumbFilePath);
  const metadata = {
    contentType: contentType,
    // To enable Client-side caching you can set the Cache-Control headers here.
    // Uncomment below.
    // 'Cache-Control': 'public,max-age=3600',
  };

  // 署名付きURLを取得する
  const result = await file
    .getSignedUrl({ action: 'read', expires: '03-01-2500' });
  const fileUrl = result[0];

  const { createCanvas, loadImage } = require('canvas');
  const basePicture = await loadImage(fileUrl);

    const canvas = createCanvas(basePicture.width, basePicture.height);
    const ctx = canvas.getContext('2d');

    ctx.drawImage(basePicture, 0, 0);

    ctx.beginPath () ;
    ctx.moveTo( 0, 0 ) ;
    ctx.lineTo( 200, 200 );
    ctx.strokeStyle = "red" ;
    ctx.lineWidth = 10 ;
    ctx.stroke() ;

    // 一時フォルダを作成する
    await mkdirp(tempLocalDir);

    // キャンバスをファイルに保存
    saveCanvas(canvas, tempLocalFile);

    // 保存したキャンバスファイルを FirebaseCloudStorage にアップロードする
    await bucket.upload(tempLocalFile, {destination: thumbFilePath, metadata: metadata});

    // 一時フォルダ内の一時ファイルを削除する
    fs.unlinkSync(tempLocalFile);

    // 署名付きURLを取得する
    const result1 = await thumbFile.getSignedUrl({action: 'read', expires: '03-01-2500'});
    const thumbFileUrl =result1[0];

    console.log(thumbFileUrl);

    return console.log('終わり');
});

function saveCanvas(canvas, filename) {
  var b64data = canvas.toDataURL().split(',')[1];
  var buffer = new Buffer(b64data, 'base64');
  writeFileSync(filename, buffer);
}
*/
