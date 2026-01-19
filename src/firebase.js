import { initializeApp } from "firebase/app";
import { getDatabase } from "firebase/database";

// TODO: Firebase Console (https://console.firebase.google.com/)에서 프로젝트 생성 후 
// 아래 설정값을 본인의 프로젝트 설정값으로 교체해주세요.
const firebaseConfig = {
  apiKey: "AIzaSyADTBnuYtw1-mxDcjoT56YkjD1meABi4xI",
  authDomain: "reservation-spell.firebaseapp.com",
  databaseURL: "https://reservation-spell-default-rtdb.firebaseio.com",
  projectId: "reservation-spell",
  storageBucket: "reservation-spell.firebasestorage.app",
  messagingSenderId: "367554549149",
  appId: "1:367554549149:web:26cbe76fa09b666248cb74",
  measurementId: "G-G3RQPE4HDJ"
};

const app = initializeApp(firebaseConfig);
export const db = getDatabase(app);
