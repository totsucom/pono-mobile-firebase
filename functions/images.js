'use strict';

/*
ここで行っていること
Cloud Firestore の basePictures コレクションに、追加や削除されたときに
Cloud Storage の basePictures/ にある画像に対して処理を行います。

● basePictures コレクションにドキュメントが追加されたとき
basePictures/{documentId}.originalPath の示す、Cloud Storage 上にアップロード
されたの画像ファイルに対し、
１．ファイル名の前に trimmed_ を付けて、トリミングした画像を同じ Cloud Storage 上に生成。
  そのパスとURLを、 .picturePath と .pictureURL に保存する。
  これらの画像生成には、.rotation, .trimXXXX の値が使用される。

２．ファイル名の前に thumb_ を付けて、サムネイル画像を同じ Cloud Storage 上に生成。
  そのURLを、 .thumbnailURL に保存する。

３．処理が終わったら、.originalPath に空文字が代入される。
  処理元になった Cloud Storage 上の元画像は削除される。

● basePictures コレクションからドキュメントが削除されたとき
１．削除されたドキュメントの、.picturePath から、 Cloud Storage 上の画像ファイル
  (trimmed_XXXX)ファイルを削除する。

２．上記で使用したパスの "trimmed_" を "thumb_" に変えて、 Cloud Storage 上の
  サムネネイルファイルを削除する
*/

/*
その他
ここでは Canvas を使って画像処理を行っている。ImageMagick を使えば多少処理は
高速化されるが（待たなければならないことには変わりない）、画像生成に自由度が
足りない。
例えば、サムネイルは正方形で生成しており、上下または左右の空白は透過処理
をおこなっている。これはFlutter側での表示を簡単にすることに貢献している。
また、実行時メモリはこちらの方が小さい。
*/

const functions = require('firebase-functions');
const adminjs = require('./admin');

const mkdirp = require('mkdirp');
const path = require('path');
const os = require('os');
const fs = require('fs');
const { createCanvas, loadImage } = require('canvas');
const ExifImage = require('exif').ExifImage;

// トリミング画像の高さ
const TRIMMED_HEIGHT = 1200;

// トリミング画像に付けるプレフィックス名
const TRIMMED_PREFIX = 'trimmed_';


// サムネイルのサイズ
const THUMB_SIZE = 200;

// サムネイルファイル名に付けるプレフィックス名
const THUMB_PREFIX = 'thumb_';


/*
 * 汎用関数
 */

// 署名付きURLを取得する
async function getUrlFromBucket(bucketFile) {
  const result = await bucketFile.getSignedUrl(
    {action: 'read', expires: '03-01-2500'});
  return result[0];
}

//キャンバスをローカルパスに保存
function saveCanvas(canvas, contentType, localPath) {
  var b64data = canvas.toDataURL(contentType).split(',')[1];
  var buffer = new Buffer(b64data, 'base64');
  fs.writeFileSync(localPath, buffer);
}

//ファイル名の拡張子を入れ替える extの例 .jpg
function replaceExt(fileName, ext) {
  return fileName.substr(0, fileName.length - path.extname(fileName).length)
  + ext;
}



/*
 * basePicturesコレクションに変更があった場合に呼び出される
 * 
 */
exports.handleImagesForBasePictures = functions.firestore
  .document('basePictures/{documentID}').onWrite(async (change, context) => {

  if (change.after.exists) {
    if (!change.before.exists) {
      //コレクションが追加された
      console.log('ベース写真が追加された');
      const message = await generateBasePictureImages(change.after.data(), change.after.id);
      return console.log('handleImagesForBasePictures: ' + message);
    } else {
      //コレクションが更新された
      //写真ありきのコレクションなので、写真が変更されることはない
      return console.log('handleImagesForBasePictures: DB更新は処理しない');
    }
  } else {
    //コレクションが削除された
    console.log('ベース写真が削除された');
    const message = await deleteBasePictureImages(change.before.data(), change.before.id);
    return console.log('handleImagesForBasePictures: ' + message);
  }
});

//ストレージからURLを取得する
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

async function generateBasePictureImages(snap, docID) {

  /*
   * 元画像の準備
   */

  //元画像のStorage情報
  const originalStoragePath = snap.originalPath;     //DBから取得
  const originalName = path.basename(originalStoragePath);
  const storageDir = path.dirname(originalStoragePath);

  //元画像のLocal情報
  const originalLocalPath = path.join(os.tmpdir(), originalName);
  const localDir = path.dirname(originalLocalPath);

  //Storageオブジェクトを作成
  const bucket = adminjs.admin.storage().bucket();
  const originalFile = bucket.file(originalStoragePath);

  //元画像をダウンロードする
  await mkdirp(localDir);
  await originalFile.download({destination: originalLocalPath});
  var originalImage = await loadImage(originalLocalPath);


  /*
   * 元画像の方向修正とトリミング
   */

   //Exif情報からOrientationを取得
  const orientation = await getOrientation(originalLocalPath);
  var angle = 0;
  if (orientation === 3) angle = 180;
  else if (orientation === 6) angle = 90;
  else if (orientation === 8) angle = 270;
  else {
    console.log('This exif orientation is not supported');
  }
  console.log('Exif orientation = ' + orientation + ' angle = ' + angle);

  angle = (angle + snap.rotation) % 360;
  console.log('Final angle = ' + angle);

  var trimLeft,trimRight,trimTop,trimBottom;
  if (angle === 0 || angle === 180) {
    trimLeft = snap.trimLeft * originalImage.width;
    trimRight = snap.trimRight * originalImage.width;
    trimTop = snap.trimTop * originalImage.height;
    trimBottom = snap.trimBottom * originalImage.height;
  } else {
    trimLeft = snap.trimLeft * originalImage.height;
    trimRight = snap.trimRight * originalImage.height;
    trimTop = snap.trimTop * originalImage.width;
    trimBottom = snap.trimBottom * originalImage.width;
  }

  var canvas, ctx, sw, sh, dw, dh;
  if (angle === 90) {
    sw = originalImage.width - trimTop - trimBottom;
    sh = originalImage.height - trimLeft - trimRight;
    dw = sh / sw * TRIMMED_HEIGHT;
    dh = TRIMMED_HEIGHT;
    canvas = createCanvas(dw, dh);
    ctx = canvas.getContext('2d');
    ctx.translate(0, dh);
    ctx.rotate(angle / 180.0 * Math.PI);
    ctx.drawImage(originalImage,
      trimTop, trimRight, sw, sh,
      -dh, -dw, dh, dw);
  } else if (angle === 180) {
    sw = originalImage.width - trimLeft - trimRight;
    sh = originalImage.height - trimTop - trimBottom;
    dw = sw / sh * TRIMMED_HEIGHT;
    dh = TRIMMED_HEIGHT;
    canvas = createCanvas(dw, dh);
    ctx = canvas.getContext('2d');
    ctx.translate(0, 0);
    ctx.rotate(angle / 180.0 * Math.PI);
    ctx.drawImage(originalImage,
      trimRight, trimBottom, sw, sh,
      -dw, -dh, dw, dh);
  } else if (angle === 270) {
    sw = originalImage.width - trimTop - trimBottom;
    sh = originalImage.height - trimLeft - trimRight;
    dw = sh / sw * TRIMMED_HEIGHT;
    dh = TRIMMED_HEIGHT;
    canvas = createCanvas(dw, dh);
    ctx = canvas.getContext('2d');
    ctx.translate(0, dh);
    ctx.rotate(angle / 180.0 * Math.PI);
    ctx.drawImage(originalImage,
      trimBottom, trimLeft, sw, sh,
      0, 0, dh, dw);
  } else /* if (angle === 0) */ {
    sw = originalImage.width - trimLeft - trimRight;
    sh = originalImage.height - trimTop - trimBottom;
    dw = sw / sh * TRIMMED_HEIGHT;
    dh = TRIMMED_HEIGHT;
    canvas = createCanvas(dw, dh);
    ctx = canvas.getContext('2d');
    ctx.drawImage(originalImage,
      trimLeft, trimTop, sw, sh,
      0, 0, dw, dh);
  }
  originalImage = undefined;  //もう使用しない（デカイ）


  /*
   * トリム画像の準備と保存
   */

  //トリム画像のStorage情報
  const trimmedName = TRIMMED_PREFIX + originalName;
  const trimmedStoragePath = path.join(storageDir, trimmedName);

  //Storageオブジェクトを作成
  const trimmedFile = bucket.file(trimmedStoragePath);
  
  //トリム画像のLocal情報
  const trimmedLocalPath = path.join(os.tmpdir(), trimmedName);

  //ローカルファイルに保存
  saveCanvas(canvas, originalFile.contentType, trimmedLocalPath);

  //ストレージにアップロードする
  await bucket.upload(trimmedLocalPath,
    {destination:trimmedFile, metadata: {contentType: originalFile.contentType}});

  //サムネイル作成のためにトリムした画像を読み直す
  //※キャンバスから直接変換できなかったw
  const trimmedImage = await loadImage(trimmedLocalPath);

  //一時ファイルを削除する
  fs.unlinkSync(trimmedLocalPath);

  //URLを取得する
  const trimmedURL = await getUrlFromBucket(trimmedFile);
  console.log('トリム画像 ' + trimmedURL);


  /*
   * サムネイル画像の生成
   */

  canvas = createCanvas(THUMB_SIZE, THUMB_SIZE);
  ctx = canvas.getContext('2d');

  ctx.beginPath();
  ctx.fillStyle = "rgba(255, 255, 255, 0.0)";
  ctx.fillRect(0, 0, THUMB_SIZE, THUMB_SIZE);
  ctx.stroke();

  var scale_x = THUMB_SIZE / trimmedImage.width;
  var scale_y = THUMB_SIZE / trimmedImage.height;
  var scale = (scale_x < scale_y) ? scale_x : scale_y;

  dw = trimmedImage.width * scale;
  dh = trimmedImage.height * scale;
  ctx.drawImage(trimmedImage,
    0, 0, trimmedImage.width, trimmedImage.height,
    (THUMB_SIZE - dw) / 2, (THUMB_SIZE - dh) / 2, dw, dh);


  /*
   * サムネイル画像の準備と保存
   */

  const contentType = 'image/png';
  const extension = '.png';

  //サムネイルのStorage情報
  const thumbName = THUMB_PREFIX + replaceExt(originalName, extension);
  const thumbStoragePath = path.join(storageDir, thumbName);

  //Storageオブジェクトを作成
  const thumbFile = bucket.file(thumbStoragePath);

  //サムネイルのLocal情報
  const thumbLocalPath = path.join(os.tmpdir(), thumbName);

  //ローカルファイルに保存
  saveCanvas(canvas, contentType, thumbLocalPath);

  //ストレージにアップロードする
  await bucket.upload(thumbLocalPath,
    {destination:thumbFile, metadata: {contentType: contentType}});

  //一時ファイルを削除する
  fs.unlinkSync(thumbLocalPath);

  //URLを取得する
  const thumbURL = await getUrlFromBucket(thumbFile);
  console.log('サムネイル ' + thumbURL);


  /*
   * ＤＢ保存と後片付け
   */

  //DBに保存
  var data = {};
  data['originalPath'] = '';  //画像を加工したのでこの項目は不要
  data['picturePath'] = trimmedStoragePath;
  data['pictureURL'] = trimmedURL;
  data['thumbnailURL'] = thumbURL;
  await adminjs.admin.firestore().collection('basePictures').doc(docID).update(data);

  //元画像を削除する
  fs.unlinkSync(originalLocalPath);
  originalFile.delete();

  return thumbURL;
}

async function deleteBasePictureImages(snap, docID) {

  //元画像のStorage情報
  const trimmedStoragePath = snap.picturePath;     //DBから取得
  console.log('trimmedStoragePath = ' + trimmedStoragePath);
  const trimmedName = path.basename(trimmedStoragePath);
  const storageDir = path.dirname(trimmedStoragePath);

  if (!trimmedName.startsWith(TRIMMED_PREFIX)) {
    return 'ファイル名にトリムプレフィックスがついてません！';
  }
  const originalName = trimmedName.substring(TRIMMED_PREFIX.length);

  //サムネイルのStorage情報
  const thumbName = THUMB_PREFIX + replaceExt(originalName, ".png");
  const thumbStoragePath = path.join(storageDir, thumbName);

  console.log('thumbStoragePath = ' + thumbStoragePath);

  //Storageオブジェクトを作成
  const bucket = adminjs.admin.storage().bucket();
  const trimmedFile = bucket.file(trimmedStoragePath);
  const thumbFile = bucket.file(thumbStoragePath);

  var message = '';
  try {
    await trimmedFile.delete();
    message += '元画像を削除しました '
  } catch (e) { }
  try {
    await thumbFile.delete();
    message += 'サムネイルを削除しました '
  } catch (e) { }

  if (message.length === 0) message = '画像は削除しませんでした';
  return message;
}

/*
 * problemコレクションに変更があった場合に呼び出される
 * 
 */
/*
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
*/
/*//キャンバスの内容をファイルに書き出す
async function saveCanvas(canvas, filePath) {
  var b64data = canvas.toDataURL("image/jpeg", 0.75).split(',')[1];
  var buffer = new Buffer(b64data, 'base64');
  fs.writeFileSync(filePath, buffer);
}*/
/*


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



  const bucket = adminjs.admin.storage().bucket();
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
  await saveCanvas(canvas, 'image/jpeg', tempLocalFile);

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
  await adminjs.admin.firestore().collection(COLLECTION_NAME).doc(docID).set({
    //decodeURI()を使ってもFirestoreに格納されるURLは%でエスケープされてしまうので注意
    completedImageURL: completedImageURL,
    imageRequired: false
  });

  console.log('handleImagesForProblem.updateProblemImages: 完了 ' + docID);
}

async function deleteProblemImages(snap, docID) {
  const filePath = 'problemImages/completedImages/{docID}.jpg';

  // Cloud Storage files.
  const bucket = adminjs.admin.storage().bucket();
  const file = bucket.file(filePath);
  
  try {
    file.delete();
  } catch (e) {
  }
}
*/
