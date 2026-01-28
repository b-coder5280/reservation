import { useState, useEffect, useMemo } from 'react'
import './index.css'
import { db } from './firebase'
import { ref, onValue, set } from "firebase/database"

const TIMES = ['00:00', '03:00', '06:00', '09:00', '12:00', '15:00', '18:00', '21:00'];
const DAYS_OF_WEEK = ['일', '월', '화', '수', '목', '금', '토'];

const DISTINCT_COLORS = [
  '#FFD1DC', // Light Pink
  '#FFDFD3', // Peach
  '#FFFFD1', // Cream Yellow
  '#D1FFD6', // Pale Green
  '#D1F5FF', // Light Sky
  '#E0D1FF', // Lavender
  '#FFD1F5', // Light Rose
  '#D1FFF3', // Mint
  '#FFE5D1', // Apricot
  '#E2E2E2', // Light Silver
  '#C4F5E1', // Magic Mint
  '#DAE8FC', // Periwinkle
  '#FFABAB', // Light Red
  '#FFC3A0', // Deep Peach
  '#D5AAFF', // Soft Purple
  '#85E3FF', // Cyan
  '#B9FBC0', // Light Emerald
  '#FBE7C6', // Bisque
  '#FF9CEE', // Hot Pink Light
  '#A0C4FF', // Cornflower Light
];

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
  const [showWeekly, setShowWeekly] = useState(false);
  const [showAdminModal, setShowAdminModal] = useState(false);
  const [isAdminAuthenticated, setIsAdminAuthenticated] = useState(false);
  const [adminPassword, setAdminPassword] = useState('');

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

    // Calculate days since MOST RECENT Tuesday 12:00
    // 0:Sun, 1:Mon, 2:Tue, 3:Wed, 4:Thu, 5:Fri, 6:Sat
    let diff = day - 2;
    if (diff < 0) diff += 7; // If Sun/Mon, go back to previous week's Tue

    // Boundary check: If today is Tuesday but before 12:00, the current cycle 
    // actually started on the Tuesday of the previous week.
    if (day === 2 && hour < 12) {
      diff = 7;
    }

    start.setDate(start.getDate() - diff);

    let end = new Date(start);
    end.setDate(end.getDate() + 7);
    end.setHours(21, 0, 0, 0); // Window ends next Tuesday 21:00

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

  // Calculate distinct colors for each user in the current view
  const nameColorMap = useMemo(() => {
    const allNames = new Set();
    Object.values(reservations).forEach(daySlots => {
      Object.values(daySlots).forEach(res => {
        if (res && res.name) allNames.add(res.name.trim());
      });
    });

    const sortedNames = Array.from(allNames).sort();
    const map = {};
    sortedNames.forEach((name, index) => {
      map[name] = DISTINCT_COLORS[index % DISTINCT_COLORS.length];
    });
    console.log('Detected Names:', sortedNames); // Debugging purpose
    return map;
  }, [reservations]);

  const getColorForName = (name) => {
    if (!name) return '#F7FAFC';
    const trimmedName = name.trim();
    return nameColorMap[trimmedName] || '#E2E2E2';
  };

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

    // Check for limit: 3 slots for Mon-Fri at 09:00, 12:00, 15:00
    const restrictedTimes = ['09:00', '12:00', '15:00'];
    const restrictedDays = ['월', '화', '수', '목', '금'];
    const currentDayName = DAYS_OF_WEEK[new Date(selectedDate).getDay()];

    if (restrictedTimes.includes(activeSlot) && restrictedDays.includes(currentDayName)) {
      let count = 0;
      const { reservableStart, reservableEnd } = bookingWindow;

      const currentSearch = new Date(reservableStart);
      while (currentSearch <= reservableEnd) {
        const ds = getLocalDateString(currentSearch);
        const dayName = DAYS_OF_WEEK[currentSearch.getDay()];

        if (restrictedDays.includes(dayName)) {
          const dayRes = reservations[ds];
          if (dayRes) {
            restrictedTimes.forEach(t => {
              if (dayRes[t] && dayRes[t].name?.trim() === userName.trim()) {
                count++;
              }
            });
          }
        }
        currentSearch.setDate(currentSearch.getDate() + 1);
      }

      if (count >= 3) {
        setModalMode('over-limit');
        return;
      }
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
    setShowAdminModal(false);
    setAdminPassword('');
  };

  const handleAdminLogin = () => {
    if (adminPassword === 'tjdus122') {
      setIsAdminAuthenticated(true);
      setError('');
    } else {
      setError('비밀번호가 올바르지 않습니다.');
    }
  };

  const handleDownload = () => {
    const { reservableStart, reservableEnd } = bookingWindow;
    let content = "";

    // Iterate from reservableStart to reservableEnd day by day
    const current = new Date(reservableStart);
    while (current <= reservableEnd) {
      const dateStr = getLocalDateString(current);
      const dayName = DAYS_OF_WEEK[current.getDay()];
      const dayReservations = reservations[dateStr];

      if (dayReservations) {
        const bookedTimes = TIMES.filter(t => dayReservations[t]);
        if (bookedTimes.length > 0) {
          const resList = bookedTimes
            .map(t => `${t} ${dayReservations[t].name}`)
            .join(', ');
          content += `${dayName} - ${resList}\n`;
        }
      }
      current.setDate(current.getDate() + 1);
    }

    if (!content) {
      alert("이번 주 예약 내역이 없습니다.");
      return;
    }

    const blob = new Blob([content], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `reservations_${new Date().toISOString().split('T')[0]}.txt`;
    link.click();
    URL.revokeObjectURL(url);
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

  const getLocalDateString = (date) => {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  };

  return (
    <>
      <div className="reserve-container">
        <h1 className="cute-title">✨ Experiment Reservation 🧪</h1>

        <div className={`status-banner ${bookingWindow.isOpen ? 'open' : 'closed'}`}>
          <div className="status-info">
            {bookingWindow.isOpen ? (
              <p>🟢 현재 예약 가능 (종료: {bookingWindow.end.toLocaleDateString()} {bookingWindow.end.getHours()}:00)</p>
            ) : (
              <p>🔴 예약 준비 중 (오픈: {bookingWindow.nextOpening.toLocaleDateString()} 12:00 PM)</p>
            )}
            <div style={{ display: 'flex', gap: '10px' }}>
              <button className="weekly-btn" onClick={() => setShowWeekly(true)}>📅 전체 일정 확인</button>
              <button className="weekly-btn" onClick={handleDownload}>📥 리스트 다운</button>
              <button className="weekly-btn" onClick={() => { setShowAdminModal(true); setIsAdminAuthenticated(false); }}>🔑 관리자</button>
            </div>
          </div>
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
                {reservedInfo && <div className="reserved-name" style={{ backgroundColor: getColorForName(reservedInfo.name), color: '#1A202C' }}>{reservedInfo.name}</div>}
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
            ) : modalMode === 'taken' ? (
              <div className="taken-modal-content">
                <div className="dog-emoji">🐕💨</div>
                <h2>어라라! 늦어버렸다!</h2>
                <p>방금 다른 분이 이 자리를 예약하셨어요.<br />발빠른 강아지가 먼저 채갔나봐요!</p>
                <p className="sub-msg">다른 남은 자리를 찾아볼까요? 🐾</p>
              </div>
            ) : (
              <div className="taken-modal-content">
                <div className="dog-emoji">🚫🐶</div>
                <h2>앗! 예약 제한이에요!</h2>
                <p>평일(월~금) 09시, 12시, 15시 타임은<br />주당 최대 3개까지만 예약 가능합니다.</p>
                <p className="sub-msg">다른 시간대나 날짜를 확인해주세요! 🐾</p>
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
      {showWeekly && (
        <div className="modal-overlay" onClick={() => setShowWeekly(false)}>
          <div className="modal weekly-modal" onClick={(e) => e.stopPropagation()}>
            <div className="weekly-header">
              <h2>전체 일정 확인</h2>
              <button className="close-icon-btn" onClick={() => setShowWeekly(false)}>×</button>
            </div>
            <div className="weekly-scroll-area">
              <table className="weekly-table">
                <thead>
                  <tr>
                    <th>시간</th>
                    {(() => {
                      const days = [];
                      let curr = new Date(bookingWindow.reservableStart);
                      for (let i = 0; i < 7; i++) {
                        days.push(new Date(curr));
                        curr.setDate(curr.getDate() + 1);
                      }
                      return days.map(d => (
                        <th key={getLocalDateString(d)}>
                          <div className="day-label">{DAYS_OF_WEEK[d.getDay()]}</div>
                          <div className="date-label">{d.getMonth() + 1}/{d.getDate()}</div>
                        </th>
                      ));
                    })()}
                  </tr>
                </thead>
                <tbody>
                  {TIMES.map(time => (
                    <tr key={time}>
                      <td className="time-col">{time}</td>
                      {(() => {
                        const days = [];
                        let curr = new Date(bookingWindow.reservableStart);
                        for (let i = 0; i < 7; i++) {
                          days.push(new Date(curr));
                          curr.setDate(curr.getDate() + 1);
                        }
                        return days.map(d => {
                          const dateStr = getLocalDateString(d);
                          const res = reservations[dateStr]?.[time];
                          const nameColor = getColorForName(res?.name);

                          return (
                            <td
                              key={`${dateStr}-${time}`}
                              className={res ? 'has-res' : ''}
                              style={res ? {
                                backgroundColor: nameColor,
                                border: `2px solid ${nameColor}`,
                                boxShadow: '0 4px 6px rgba(0,0,0,0.05)'
                              } : {}}
                            >
                              <div className="slot-content">
                                <span className="slot-time">{time}</span>
                                {res ? (
                                  <span className="res-name-tag" style={{ color: '#1A202C' }}>{res.name}</span>
                                ) : <span className="empty-slot">-</span>}
                              </div>
                            </td>
                          );
                        });
                      })()}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}
      {showAdminModal && (
        <div className="modal-overlay" onClick={closeModal}>
          <div className="modal weekly-modal" onClick={(e) => e.stopPropagation()}>
            {!isAdminAuthenticated ? (
              <>
                <h2>관리자 로그인</h2>
                <div className="input-group">
                  <label htmlFor="admin-pw">관리자 암호</label>
                  <input
                    id="admin-pw"
                    type="password"
                    placeholder="암호를 입력하세요"
                    value={adminPassword}
                    onChange={(e) => setAdminPassword(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && handleAdminLogin()}
                    autoFocus
                  />
                </div>
                {error && <p className="error-message">{error}</p>}
                <div className="modal-actions">
                  <button className="secondary" onClick={closeModal}>닫기</button>
                  <button className="primary" onClick={handleAdminLogin}>로그인</button>
                </div>
              </>
            ) : (
              <div className="admin-view">
                <h2>📋 전체 예약 비밀번호 리스트</h2>
                <div className="weekly-scroll-area" style={{ maxHeight: '60vh', marginTop: '1rem' }}>
                  <table className="weekly-table" style={{ fontSize: '0.9rem' }}>
                    <thead>
                      <tr>
                        <th>날짜</th>
                        <th>시간</th>
                        <th>이름</th>
                        <th>비밀번호</th>
                      </tr>
                    </thead>
                    <tbody>
                      {Object.keys(reservations).sort().map(date => (
                        Object.keys(reservations[date]).sort().map(time => (
                          <tr key={`${date}-${time}`}>
                            <td>{date}</td>
                            <td>{time}</td>
                            <td>{reservations[date][time].name}</td>
                            <td style={{ color: '#E11D48', fontWeight: 'bold' }}>{reservations[date][time].password}</td>
                          </tr>
                        ))
                      ))}
                    </tbody>
                  </table>
                </div>
                <div className="modal-actions">
                  <button className="primary" onClick={closeModal}>확인 완료</button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </>
  )
}

export default App
