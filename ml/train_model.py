"""
Train a simple ML model to predict whether irrigation will likely be
needed soon (Stage 5).

There's no real ESP32 sensor history yet, so this script generates a
small *simulated* dataset first, using a simple rule (hot + dry air dries
out soil faster, recent watering helps) plus a little random noise. It
then trains a small Random Forest classifier on that data and saves it to
model.pkl, so app.py can load it and make live predictions.

Re-run this any time you want to retrain - e.g. once real sensor history
has been collected from the ESP32:

    python ml/train_model.py
"""

import os
import pickle

import numpy as np
import pandas as pd
from sklearn.ensemble import RandomForestClassifier
from sklearn.metrics import accuracy_score, classification_report
from sklearn.model_selection import train_test_split

GROWTH_STAGES = ["Seedling", "Vegetative", "Flowering", "Fruiting"]
MOISTURE_THRESHOLDS = {"Seedling": 60, "Vegetative": 50, "Flowering": 45, "Fruiting": 40}

# Save next to this script, so it works no matter which folder you run it from
MODEL_PATH = os.path.join(os.path.dirname(__file__), "model.pkl")


def generate_training_data(n_samples=600, seed=42):
    """Build a small simulated dataset standing in for real sensor history.

    Each row is one snapshot of conditions. The label (will_need_irrigation)
    says whether soil moisture is projected to soon drop below the growth
    stage's threshold, based on a simple "drying pressure" from heat and
    low humidity, offset by whether the plant was recently watered.
    """
    rng = np.random.default_rng(seed)
    rows = []

    for _ in range(n_samples):
        growth_stage = rng.choice(GROWTH_STAGES)
        threshold = MOISTURE_THRESHOLDS[growth_stage]

        soil_moisture = rng.uniform(20, 90)
        soil_temperature = rng.uniform(15, 35)
        air_temperature = rng.uniform(15, 40)
        humidity = rng.uniform(20, 95)
        previous_watering = int(rng.choice([0, 1]))

        # Hotter, drier air dries the soil out faster
        dry_pressure = (air_temperature - 20) * 0.3 + (60 - humidity) * 0.1
        projected_moisture = soil_moisture - dry_pressure + (10 if previous_watering else 0)

        will_need_irrigation = int(projected_moisture < threshold)

        # Flip a few labels at random - real conditions are never perfectly predictable
        if rng.random() < 0.05:
            will_need_irrigation = 1 - will_need_irrigation

        rows.append(
            {
                "soil_moisture": round(soil_moisture, 1),
                "soil_temperature": round(soil_temperature, 1),
                "air_temperature": round(air_temperature, 1),
                "humidity": round(humidity, 1),
                "growth_stage": growth_stage,
                "previous_watering": previous_watering,
                "will_need_irrigation": will_need_irrigation,
            }
        )

    return pd.DataFrame(rows)


def main():
    print("Generating simulated training data...")
    df = generate_training_data()

    # Turn the growth_stage column into one-hot columns (growth_stage_Seedling, etc.)
    # so the model only sees numbers, never text
    df = pd.get_dummies(df, columns=["growth_stage"], prefix="growth_stage")

    feature_columns = [c for c in df.columns if c != "will_need_irrigation"]
    X = df[feature_columns]
    y = df["will_need_irrigation"]

    X_train, X_test, y_train, y_test = train_test_split(X, y, test_size=0.2, random_state=42)

    print("Training RandomForestClassifier...")
    model = RandomForestClassifier(n_estimators=50, max_depth=5, random_state=42)
    model.fit(X_train, y_train)

    y_pred = model.predict(X_test)
    print(f"\nTest accuracy: {accuracy_score(y_test, y_pred):.2f}")
    print("\nClassification report:")
    print(classification_report(y_test, y_pred, target_names=["No irrigation needed", "Irrigation needed soon"]))

    # Save the model together with the exact feature column order it
    # expects, so app.py can build a matching row at prediction time.
    with open(MODEL_PATH, "wb") as f:
        pickle.dump({"model": model, "feature_columns": feature_columns}, f)

    print(f"\nSaved trained model to {MODEL_PATH}")


if __name__ == "__main__":
    main()
