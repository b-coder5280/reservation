import { useState, useEffect, useMemo } from 'react'
import './index.css'
import { db } from './firebase'
import { ref, onValue, set } from "firebase/database"

const TIMES = ['06:00', '09:00', '13:00', '16:00', '19:00'];
const DAYS_OF_WEEK = ['일', '월', '화', '수', '목', '금', '토'];

function App() {
  const [now, setNow] = useState(new Date());
  const [currentMonth, setCurrentMonth] = useState(new Date());
  const [selectedDate, setSelectedDate] = useState(new Date().toISOString().split('T')[0]);
  const [reservations, setReservations] = useState({});
  const [modalMode, setModalMode] = useState(null);
  const [activeSlot, setActiveSlot] = useState(null);
  const [userName, setUserName] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');

  // Update current time every minute
  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 60000);
    return () => clearInterval(timer);
  }, []);

  // Reservation Rule Logic
  const bookingWindow = useMemo(() => {
    const current = new Date(now);
    const day = current.getDay(); // 0: Sun, 1: Mon, 2: Tue ...
    const hour = current.getHours();

    let start = new Date(now);
    start.setHours(12, 0, 0, 0);

    let diff = day - 2; // Days from Tuesday
    if (diff < 0) diff += 7;
    // Special case: Tuesday but before 12:00 PM - part of the previous cycle
    if (day === 2 && hour < 12) {
      diff = 7;
    }

    start.setDate(start.getDate() - diff);

    let end = new Date(start);
    end.setDate(end.getDate() + 7);
    end.setHours(19, 0, 0, 0); // Window ends next Tuesday 19:00

    const isOpen = now >= start && now <= end;

    // Calculate the next opening time if closed
    let nextOpening = new Date(start);
    if (now > end) {
      nextOpening.setDate(nextOpening.getDate() + 7);
    } else if (now < start) {
      nextOpening = start;
    }

    // Exclude the starting Tuesday from reservable slots (as per user request)
    let validStart = new Date(start);
    validStart.setDate(validStart.getDate() + 1);
    validStart.setHours(0, 0, 0, 0);

    return {
      start,
      end,
      isOpen,
      nextOpening,
      reservableStart: validStart,
      reservableEnd: end
    };
  }, [now]);

  // Sync with Firebase Realtime Database
  useEffect(() => {
    const resRef = ref(db, 'reservations');
    const unsubscribe = onValue(resRef, (snapshot) => {
      const data = snapshot.val();
      setReservations(data || {});
    });
    return () => unsubscribe();
  }, []);

  const isSlotReservable = (dateStr, time) => {
    if (!bookingWindow.isOpen) return false;

    const [hours, minutes] = time.split(':').map(Number);
    const slotTime = new Date(dateStr);
    slotTime.setHours(hours, minutes, 0, 0);

    return slotTime >= bookingWindow.reservableStart && slotTime <= bookingWindow.reservableEnd;
  };

  const handleSlotClick = (time) => {
    if (!isSlotReservable(selectedDate, time)) {
      if (!bookingWindow.isOpen) {
        alert("현재 예약 기간이 아닙니다.");
      } else {
        alert("해당 시간대는 이번 주 예약 범위가 아닙니다.");
      }
      return;
    }

    setActiveSlot(time);
    if (reservations[selectedDate]?.[time]) {
      setModalMode('cancel');
    } else {
      setModalMode('create');
    }
    setError('');
  };

  const handleCreateReservation = () => {
    if (!userName.trim() || !password.trim()) {
      setError('이름과 비밀번호를 모두 입력해주세요.');
      return;
    }

    // Checking directly against current state since it's synced via Firebase
    if (reservations[selectedDate]?.[activeSlot]) {
      setModalMode('taken');
      return;
    }

    const newReservations = {
      ...reservations,
      [selectedDate]: {
        ...reservations[selectedDate],
        [activeSlot]: { name: userName, password: password }
      }
    };

    set(ref(db, 'reservations'), newReservations)
      .then(() => closeModal())
      .catch((err) => {
        console.error(err);
        setError('예약 저장 중 오류가 발생했습니다.');
      });
  };

  const handleCancelReservation = () => {
    const reservedInfo = reservations[selectedDate]?.[activeSlot];
    if (reservedInfo && reservedInfo.password === password) {
      const updatedDateInfo = { ...reservations[selectedDate] };
      delete updatedDateInfo[activeSlot];

      const newRes = { ...reservations, [selectedDate]: updatedDateInfo };
      if (Object.keys(updatedDateInfo).length === 0) delete newRes[selectedDate];

      set(ref(db, 'reservations'), newRes)
        .then(() => closeModal())
        .catch((err) => {
          console.error(err);
          setError('취소 중 오류가 발생했습니다.');
        });
    } else {
      setError('비밀번호가 일치하지 않습니다.');
    }
  };

  const closeModal = () => {
    setModalMode(null);
    setActiveSlot(null);
    setUserName('');
    setPassword('');
    setError('');
  };

  const renderCalendar = () => {
    const year = currentMonth.getFullYear();
    const month = currentMonth.getMonth();
    const firstDay = new Date(year, month, 1).getDay();
    const daysInMonth = new Date(year, month + 1, 0).getDate();
    const days = [];

    for (let i = 0; i < firstDay; i++) {
      days.push(<div key={`empty-${i}`} className="calendar-day empty"></div>);
    }

    for (let d = 1; d <= daysInMonth; d++) {
      const dateStr = `${year}-${String(month + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
      const isToday = now.toISOString().split('T')[0] === dateStr;
      const isSelected = selectedDate === dateStr;
      const hasReservation = reservations[dateStr] && Object.keys(reservations[dateStr]).length > 0;

      const isDayReachable = TIMES.some(t => isSlotReservable(dateStr, t));

      days.push(
        <div
          key={d}
          className={`calendar-day ${isSelected ? 'active' : ''} ${isToday ? 'today' : ''} ${hasReservation ? 'has-res' : ''} ${!isDayReachable ? 'locked' : ''}`}
          onClick={() => setSelectedDate(dateStr)}
        >
          <span className="date-num">{d}</span>
          {hasReservation && <div className="res-dot"></div>}
        </div>
      );
    }
    return days;
  };

  return (
    <>
      <div className="reserve-container">
        <h1 className="cute-title">✨ Experiment Reservation 🧪</h1>

        <div className={`status-banner ${bookingWindow.isOpen ? 'open' : 'closed'}`}>
          {bookingWindow.isOpen ? (
            <p>🟢 현재 예약 가능 (종료: {bookingWindow.end.toLocaleDateString()} {bookingWindow.end.getHours()}:00)</p>
          ) : (
            <p>🔴 예약 준비 중 (오픈: {bookingWindow.nextOpening.toLocaleDateString()} 12:00 PM)</p>
          )}
        </div>

        <div className="calendar-section">
          <div className="calendar-header">
            <button className="month-nav" onClick={() => setCurrentMonth(new Date(currentMonth.getFullYear(), currentMonth.getMonth() - 1, 1))}>&lt;</button>
            <h2>{currentMonth.getFullYear()}년 {currentMonth.getMonth() + 1}월</h2>
            <button className="month-nav" onClick={() => setCurrentMonth(new Date(currentMonth.getFullYear(), currentMonth.getMonth() + 1, 1))}>&gt;</button>
          </div>

          <div className="calendar-grid">
            {DAYS_OF_WEEK.map(day => <div key={day} className="day-name">{day}</div>)}
            {renderCalendar()}
          </div>
        </div>

        <div className="selected-info">
          <h3>{selectedDate} 예약 현황</h3>
        </div>

        <div className="time-grid">
          {TIMES.map((time) => {
            const reservedInfo = reservations[selectedDate]?.[time];
            const reservable = isSlotReservable(selectedDate, time);
            return (
              <div
                key={time}
                className={`time-slot ${reservedInfo ? 'reserved' : ''} ${!reservable ? 'locked' : ''}`}
                onClick={() => handleSlotClick(time)}
              >
                <span className="time">{time}</span>
                <span className="status">
                  {!reservable ? '예약 불가' : (reservedInfo ? '예약 완료' : '예약 가능')}
                </span>
                {reservedInfo && <div className="reserved-name">{reservedInfo.name}</div>}
              </div>
            );
          })}
        </div>
      </div>

      {modalMode && (
        <div className="modal-overlay" onClick={closeModal}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            {modalMode === 'create' ? (
              <>
                <h2>예약하기</h2>
                <p>{selectedDate} {activeSlot} 타임</p>
                <div className="input-group">
                  <label htmlFor="name">성함</label>
                  <input id="name" type="text" placeholder="이름을 입력해주세요" value={userName} onChange={(e) => setUserName(e.target.value)} autoFocus />
                </div>
                <div className="input-group">
                  <label htmlFor="password">비밀번호 (취소 시 필요)</label>
                  <input id="password" type="password" placeholder="비밀번호 입력" value={password} onChange={(e) => setPassword(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && handleCreateReservation()} />
                </div>
              </>
            ) : modalMode === 'cancel' ? (
              <>
                <h2>예약 취소</h2>
                <p>{selectedDate} {activeSlot} 타임 예약 취소</p>
                <div className="input-group">
                  <label htmlFor="cancel-password">비밀번호 확인</label>
                  <input id="cancel-password" type="password" placeholder="예약 시 설정한 비밀번호" value={password} onChange={(e) => setPassword(e.target.value)} autoFocus onKeyDown={(e) => e.key === 'Enter' && handleCancelReservation()} />
                </div>
              </>
            ) : (
              <div className="taken-modal-content">
                <div className="dog-emoji">🐕💨</div>
                <h2>어라라! 늦어버렸다!</h2>
                <p>방금 다른 분이 이 자리를 예약하셨어요.<br />발빠른 강아지가 먼저 채갔나봐요!</p>
                <p className="sub-msg">다른 남은 자리를 찾아볼까요? 🐾</p>
              </div>
            )}
            {error && <p className="error-message">{error}</p>}
            <div className="modal-actions">
              <button className="secondary" onClick={closeModal}>
                {modalMode === 'taken' ? '확인' : '닫기'}
              </button>
              {modalMode === 'create' ? (
                <button className="primary" onClick={handleCreateReservation}>예약 확정</button>
              ) : modalMode === 'cancel' ? (
                <button className="danger" onClick={handleCancelReservation}>예약 취소</button>
              ) : null}
            </div>
          </div>
        </div>
      )}
    </>
  )
}

export default App
