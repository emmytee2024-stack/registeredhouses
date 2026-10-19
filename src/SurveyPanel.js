import { Crosshair, MapPin, PanelBottomClose, PanelBottomOpen, Save, Trash2 } from 'lucide-react';

function formatDistance(meters) {
  if (!Number.isFinite(meters)) return '—';
  return meters >= 1000 ? `${(meters / 1000).toFixed(2)} km` : `${meters.toFixed(1)} m`;
}

function formatArea(squareMeters) {
  if (!Number.isFinite(squareMeters)) return '—';
  return squareMeters >= 10000
    ? `${(squareMeters / 10000).toFixed(3)} ha`
    : `${squareMeters.toFixed(1)} m²`;
}

function SurveyPanel({
  collapsed,
  onToggleCollapsed,
  userLocation,
  isTracking,
  captureMovementAsBoundary,
  onCaptureMovementAsBoundaryChange,
  trackingStatus,
  locationError,
  points,
  pointIndexToMove,
  onPointIndexToMove,
  boundaryStatus,
  boundaryReason,
  area,
  perimeter,
  housesInside,
  houseCount,
  surveyName,
  onSurveyNameChange,
  surveyColor,
  onSurveyColorChange,
  mapMode,
  onMapModeChange,
  onCaptureGps,
  onStartTracking,
  onPlotArea,
  onOpenBoundary,
  onRemovePoint,
  onRemoveAllPoints,
  onSaveBoundary,
  onStartNew,
  savedAreas,
  activeAreaId,
  onSelectSavedArea,
  saveError,
  isCapturingGps,
  isBoundaryClosed,
  housesOutside,
}) {
  return (
    <section aria-label="Boundary surveying controls" className={`survey-panel${collapsed ? ' is-collapsed' : ''}`}>
      <header className="survey-panel-heading">
        <div>
          <span className="survey-panel-kicker">FIELD SURVEY</span>
          <h2>Boundary survey <span className={`survey-status is-${boundaryStatus}`}>{boundaryStatus}</span></h2>
        </div>
        <button
          aria-expanded={!collapsed}
          aria-label={collapsed ? 'Expand survey controls' : 'Collapse survey controls'}
          className="survey-collapse-button"
          onClick={onToggleCollapsed}
          type="button"
        >
          {collapsed ? <PanelBottomOpen aria-hidden="true" size={18} /> : <PanelBottomClose aria-hidden="true" size={18} />}
        </button>
      </header>
      {!collapsed && (
        <div className="survey-panel-content">
          <div className="survey-gps-summary" aria-live="polite">
            <div className="survey-gps-heading">
              <Crosshair aria-hidden="true" size={16} />
              <strong>{isTracking ? 'Tracking active' : 'Tracking stopped'}</strong>
              {userLocation && <span>±{Math.round(userLocation.accuracy)} m</span>}
            </div>
            {userLocation ? (
              <span className="survey-coordinates">
                Lat {userLocation.latitude.toFixed(6)} · Lng {userLocation.longitude.toFixed(6)}
              </span>
            ) : <span className="survey-coordinates">Waiting for a device GPS fix</span>}
            {trackingStatus && <small>{trackingStatus}</small>}
            {locationError && <small className="survey-error" role="alert">{locationError}</small>}
          </div>

          <div className="survey-actions">
            <button className="survey-action-button survey-primary-action" disabled={isCapturingGps} onClick={onCaptureGps} type="button">
              <Crosshair aria-hidden="true" size={17} /> {isCapturingGps ? 'Getting GPS…' : 'Capture GPS point'}
            </button>
            <button className="survey-action-button" onClick={onStartTracking} type="button">
              <Crosshair aria-hidden="true" size={17} /> {isTracking ? 'Stop GPS tracking' : 'Start GPS tracking'}
            </button>
            <button
              aria-pressed={mapMode === 'add'}
              className={`survey-action-button${mapMode === 'add' ? ' is-active' : ''}`}
              onClick={() => onMapModeChange(mapMode === 'add' ? 'idle' : 'add')}
              type="button"
            >
              <MapPin aria-hidden="true" size={17} /> {mapMode === 'add' ? 'Tap map to add · Cancel' : 'Add point on map'}
            </button>
          </div>
          <label className="survey-track-capture">
            <input
              checked={captureMovementAsBoundary}
              onChange={(event) => onCaptureMovementAsBoundaryChange(event.target.checked)}
              type="checkbox"
            />
            <span>
              <strong>Capture walking track as boundary points</strong>
              <small>Start GPS tracking, then walk the boundary. Only accepted GPS fixes are added.</small>
            </span>
          </label>

          <label className="survey-name-field">
            <span>Survey name</span>
            <input
              aria-label="Survey name"
              maxLength={80}
              onChange={(event) => onSurveyNameChange(event.target.value)}
              placeholder="e.g. Community block A"
              value={surveyName}
            />
          </label>

          <label className="survey-color-field">
            <span>
              <strong>Area fill color</strong>
              <small>{surveyColor.toUpperCase()}</small>
            </span>
            <input
              aria-label="Survey area fill color"
              onChange={(event) => onSurveyColorChange(event.target.value)}
              type="color"
              value={surveyColor}
            />
          </label>

          <div className="survey-stat-grid" aria-label="Boundary measurements">
            <div><span>Boundary points</span><strong>{points.length}</strong></div>
            <div><span>Area</span><strong>{formatArea(area)}</strong></div>
            <div><span>Perimeter</span><strong>{formatDistance(perimeter)}</strong></div>
            <div><span>Houses inside</span><strong>{housesInside === null ? '—' : housesInside}</strong></div>
            <div><span>Houses outside</span><strong>{housesOutside === null ? '—' : housesOutside} <small>of {houseCount} registered</small></strong></div>
          </div>

          {boundaryReason && <p className="survey-boundary-reason" role="status">{boundaryReason}</p>}

          {points.length > 0 && (
            <ol aria-label="Boundary point list" className="survey-point-list">
              {points.map((point, index) => (
                <li className={pointIndexToMove === index ? 'is-selected' : ''} key={`${point.timestamp || 'map'}-${index}`}>
                  <button
                    aria-pressed={pointIndexToMove === index}
                    onClick={() => onPointIndexToMove(pointIndexToMove === index ? null : index)}
                    type="button"
                  >
                    <span>{index + 1}</span>
                    <span>{point.latitude.toFixed(5)}, {point.longitude.toFixed(5)}</span>
                    {Number.isFinite(point.accuracy) && <small>±{Math.round(point.accuracy)} m</small>}
                  </button>
                  <button aria-label={`Remove boundary point ${index + 1}`} onClick={() => onRemovePoint(index)} type="button">
                    <Trash2 aria-hidden="true" size={15} />
                  </button>
                </li>
              ))}
            </ol>
          )}
          {pointIndexToMove !== null && (
            <p className="survey-map-hint">Tap the map to move point {pointIndexToMove + 1}.</p>
          )}

          <div className="survey-edit-actions">
            <button className="survey-plot-action" disabled={points.length < 3} onClick={onPlotArea} type="button">
              <MapPin aria-hidden="true" size={15} /> Plot area
            </button>
            <button disabled={!isBoundaryClosed} onClick={onOpenBoundary} type="button">Reopen</button>
            <button disabled={!points.length} onClick={onRemoveAllPoints} type="button">Clear points</button>
            <button disabled={!['closed', 'saved'].includes(boundaryStatus)} onClick={onSaveBoundary} type="button">
              <Save aria-hidden="true" size={15} /> {activeAreaId ? 'Save changes' : 'Save boundary'}
            </button>
          </div>
          {saveError && <p className="survey-error" role="alert">{saveError}</p>}

          <label className="survey-saved-select">
            <span>Saved areas ({savedAreas.length})</span>
            <select aria-label="Open saved survey area" onChange={(event) => onSelectSavedArea(event.target.value)} value={activeAreaId || ''}>
              <option value="">Current draft</option>
              {savedAreas.map((savedArea) => (
                <option key={savedArea.id} value={savedArea.id}>{savedArea.name}</option>
              ))}
            </select>
          </label>
          <button className="survey-new-button" disabled={points.length > 0 && boundaryStatus !== 'saved'} onClick={onStartNew} type="button">
            Start a new survey
          </button>

          <p className="survey-caveat">
            GPS accuracy varies. These measurements are approximate field observations, not an official land or property boundary.
          </p>
        </div>
      )}
    </section>
  );
}

export default SurveyPanel;
