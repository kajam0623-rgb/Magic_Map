declare global {
  type KakaoMapClickEvent = {
    latLng: kakao.maps.LatLng;
  };

  type KakaoAddressSearchResult = {
    address_name: string;
    x: string;
    y: string;
  };

  interface Window {
    kakao?: typeof kakao;
  }

  namespace kakao {
    namespace maps {
      function load(callback: () => void): void;

      class LatLng {
        constructor(lat: number, lng: number);
        getLat(): number;
        getLng(): number;
      }

      class Map {
        constructor(container: HTMLElement, options: { center: LatLng; level: number });
        setCenter(latlng: LatLng): void;
        setLevel(level: number): void;
      }

      class Marker {
        constructor(options: { map: Map; position: LatLng });
        setMap(map: Map | null): void;
        setPosition(position: LatLng): void;
      }

      class Circle {
        constructor(options: {
          map: Map;
          center: LatLng;
          radius: number;
          strokeWeight?: number;
          strokeColor?: string;
          strokeOpacity?: number;
          strokeStyle?: string;
          fillColor?: string;
          fillOpacity?: number;
        });
        setMap(map: Map | null): void;
        setPosition(position: LatLng): void;
        setRadius(radius: number): void;
      }

      namespace event {
        function addListener(
          target: Map,
          type: "click",
          handler: (event: KakaoMapClickEvent) => void,
        ): void;
        function removeListener(
          target: Map,
          type: "click",
          handler: (event: KakaoMapClickEvent) => void,
        ): void;
      }

      namespace services {
        const Status: {
          OK: string;
          ZERO_RESULT: string;
          ERROR: string;
        };

        class Geocoder {
          addressSearch(
            address: string,
            callback: (result: KakaoAddressSearchResult[], status: string) => void,
          ): void;
        }
      }
    }
  }
}

export {};
